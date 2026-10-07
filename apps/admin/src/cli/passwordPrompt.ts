import { emitKeypressEvents } from 'node:readline';

/** Interactive terminal only: no argv/environment password and no echoed secret. */
export function promptHiddenPassword(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY)
    throw new Error('Use an interactive terminal to set the operator password.');
  return new Promise((resolve, reject) => {
    let value = '';
    let tooLong = false;
    const raw = input.isRaw;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stdout.write(label);
    function finish(error?: Error) {
      input.removeListener('keypress', key);
      input.setRawMode(raw);
      input.pause();
      process.stdout.write('\n');
      if (error) {
        value = '';
        reject(error);
      } else resolve(value);
    }
    function key(
      text: string | undefined,
      event: { name?: string; ctrl?: boolean; meta?: boolean },
    ) {
      if (event.ctrl && event.name === 'c') {
        finish(new Error('Operator setup cancelled.'));
        return;
      }
      if (event.name === 'return' || event.name === 'enter') {
        finish(
          tooLong
            ? new Error('Password exceeds 128 characters. Run setup again with a shorter password.')
            : undefined,
        );
        return;
      }
      if (event.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (!event.ctrl && !event.meta && text && !/[\u0000-\u001f\u007f]/.test(text)) {
        if (Array.from(value + text).length <= 128) value += text;
        else tooLong = true;
      }
    }
    input.on('keypress', key);
  });
}
