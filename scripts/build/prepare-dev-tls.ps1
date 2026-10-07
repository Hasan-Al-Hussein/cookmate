#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EndpointIp,
    [Parameter(Mandatory)] [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')] [string] $Generation,
    [switch] $Generate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This helper requires Windows and its file ACLs.' }

$address = $null
if (-not [Net.IPAddress]::TryParse($EndpointIp, [ref] $address) -or
    $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    $address.ToString() -ne $EndpointIp -or
    $EndpointIp -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)') {
    throw 'Choose the laptop current RFC1918 IPv4 address in canonical dotted form.'
}

$openssl = 'C:\Program Files\OpenSSL-Win64\bin\openssl.exe'
if (-not (Test-Path -LiteralPath $openssl -PathType Leaf)) { throw 'The expected OpenSSL executable is missing.' }
$privateRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CookMate'))
$tlsRoot = Join-Path $privateRoot 'tls'
$destination = [IO.Path]::GetFullPath((Join-Path $tlsRoot $Generation))
if (-not $destination.StartsWith($tlsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The destination must stay inside the private TLS folder.'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User

function Assert-NoReparsePoint([string] $Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'TLS output cannot use a reparse-point ancestor.' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Assert-PrivateDirectory([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'The protected CookMate directory must already exist.' }
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
        $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rules[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
        $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw 'The existing directory must have a protected, current-user-only inheritable FullControl ACL. It will not be changed automatically.'
    }
}

function New-PrivateDirectory([string] $Path) {
    if (Test-Path -LiteralPath $Path) { throw 'Refusing to reuse an existing output directory.' }
    $null = New-Item -ItemType Directory -Path $Path
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
    Assert-PrivateDirectory $Path
}

Assert-NoReparsePoint $destination
Assert-PrivateDirectory $privateRoot
if (Test-Path -LiteralPath $destination) { throw 'This generation already exists. Use a new generation name; no files will be overwritten.' }
if (Test-Path -LiteralPath $tlsRoot) { Assert-PrivateDirectory $tlsRoot }

$file = @{}
foreach ($name in @('ca.key.pem', 'ca.cert.pem', 'ca.cert.cer', 'ca.cert.srl', 'server.key.pem', 'server.csr.pem', 'server.cert.pem', 'ca.cnf', 'server.cnf', 'key-public.pem', 'cert-public.pem', 'manifest.json', '.generation-reserved')) {
    $file[$name] = Join-Path $destination $name
}
$steps = @(
    @{ name = 'CA private key'; arguments = @('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', $file['ca.key.pem']) },
    @{ name = 'CA certificate'; arguments = @('req', '-new', '-x509', '-batch', '-key', $file['ca.key.pem'], '-sha256', '-days', '365', '-config', $file['ca.cnf'], '-extensions', 'ca', '-out', $file['ca.cert.pem']) },
    @{ name = 'Server private key'; arguments = @('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', $file['server.key.pem']) },
    @{ name = 'Server request'; arguments = @('req', '-new', '-batch', '-key', $file['server.key.pem'], '-config', $file['server.cnf'], '-out', $file['server.csr.pem']) },
    @{ name = 'Server certificate'; arguments = @('x509', '-req', '-in', $file['server.csr.pem'], '-CA', $file['ca.cert.pem'], '-CAkey', $file['ca.key.pem'], '-CAcreateserial', '-sha256', '-days', '90', '-extfile', $file['server.cnf'], '-extensions', 'server', '-out', $file['server.cert.pem']) },
    @{ name = 'Chain and IP validation'; arguments = @('verify', '-CAfile', $file['ca.cert.pem'], '-purpose', 'sslserver', '-verify_ip', $EndpointIp, $file['server.cert.pem']) },
    @{ name = 'Key public component'; arguments = @('pkey', '-in', $file['server.key.pem'], '-pubout', '-out', $file['key-public.pem']) },
    @{ name = 'Certificate public component'; arguments = @('x509', '-in', $file['server.cert.pem'], '-pubkey', '-noout', '-out', $file['cert-public.pem']) },
    @{ name = 'Public CA DER export'; arguments = @('x509', '-in', $file['ca.cert.pem'], '-outform', 'DER', '-out', $file['ca.cert.cer']) }
)
$plan = [ordered]@{
    mode = 'plan'; endpoint = "https://${EndpointIp}:3443"; directory = $destination
    publicCertificate = $file['ca.cert.cer']; rootDays = 365; serverDays = 90
    changes = 'New protected files only. No trust store, firewall, network profile, server, gateway.env or provider changes.'
    files = @($file.Keys | Sort-Object); executable = $openssl; steps = $steps
}
if (-not $Generate) { $plan | ConvertTo-Json -Depth 6; return }

if (-not (Test-Path -LiteralPath $tlsRoot)) { New-PrivateDirectory $tlsRoot }
New-PrivateDirectory $destination
# An exclusive marker also fences simultaneous invocations using the same generation.
$reservation = [IO.File]::Open($file['.generation-reserved'], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    @'
[req]
prompt = no
distinguished_name = dn
[dn]
CN = CookMate Private Development Root
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
'@ | Set-Content -LiteralPath $file['ca.cnf'] -Encoding ascii
    @"
[req]
prompt = no
distinguished_name = dn
[dn]
CN = CookMate Private Gateway
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:$EndpointIp
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
"@ | Set-Content -LiteralPath $file['server.cnf'] -Encoding ascii
    foreach ($step in $steps) {
        $arguments = $step.arguments
        $null = & $openssl @arguments 2>&1
        if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed during $($step.name). Protected partial files are retained; this generation is not ready." }
    }
    # These are public-key files, not private-key hashes.
    if ((Get-FileHash -LiteralPath $file['key-public.pem'] -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $file['cert-public.pem'] -Algorithm SHA256).Hash) {
        throw 'Server certificate and key do not match. This generation is not ready.'
    }
    foreach ($name in @('ca.key.pem', 'server.key.pem')) {
        $rules = @((Get-Acl -LiteralPath $file[$name]).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
            $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            throw 'Private-key ACL verification failed. This generation is not ready.'
        }
    }
    $manifest = [ordered]@{
        status = 'generated-and-offline-verified'; createdAt = [DateTime]::UtcNow.ToString('o')
        endpoint = $plan.endpoint; rootDays = 365; serverDays = 90
        certificatePath = $file['server.cert.pem']; privateKeyPath = $file['server.key.pem']
        publicRootCertificate = $file['ca.cert.cer']
        publicRootSha256 = (Get-FileHash -LiteralPath $file['ca.cert.cer'] -Algorithm SHA256).Hash
        phoneTrustAndNetwork = 'not configured or verified'
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $file['manifest.json'] -Encoding utf8
    $manifest | ConvertTo-Json
} finally {
    $reservation.Dispose()
}
