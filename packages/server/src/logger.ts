import { pino } from 'pino'

/** JSON to stdout, secrets redacted, never request bodies (deployment.md section 5). */
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.current_password',
        '*.new_password',
        '*.token',
        '*.access_token',
        '*.device_code',
        '*.authorization',
      ],
      censor: '[redacted]',
    },
  })
}
