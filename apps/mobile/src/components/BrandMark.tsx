import { Platform } from 'react-native';
import Svg, { Path, type SvgProps } from 'react-native-svg';

/** Hand-authored vector adaptation of the supplied raster, simplified at small sizes. */
export function BrandMark({ color = '#FFFCF8', ...props }: SvgProps & { color?: string }) {
  return (
    <Svg
      width={28}
      height={28}
      viewBox="170 210 665 550"
      {...(Platform.OS === 'web' ? { 'aria-hidden': true } : { accessible: false })}
      focusable={false}
      {...props}
    >
      <Path
        d="M332 379C346 211 614 211 653 374C819 364 849 577 674 610V713C561 680 443 680 332 713V611C164 604 180 389 332 379Z"
        fill="none"
        stroke={color}
        strokeWidth={30}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M579 428C579 474 557 490 513 497C557 505 572 521 579 568C586 521 601 505 646 497C601 490 585 474 579 428Z"
        fill={color}
      />
    </Svg>
  );
}
