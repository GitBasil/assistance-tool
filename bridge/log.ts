const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let min: number = LEVELS.info;
// One JSON object per line when not on a terminal (containers, log shippers); readable text otherwise.
let json = !process.stdout.isTTY;

export function setupLog(level: Level, format = process.env.ASSIST_LOG_FORMAT) {
  min = LEVELS[level];
  if (format === 'json') json = true;
  else if (format === 'text') json = false;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < min) return;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (json) return void out.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }) + '\n');
  const extra = fields && Object.keys(fields).length ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
  out.write(`[assist] ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${extra}\n`);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};
