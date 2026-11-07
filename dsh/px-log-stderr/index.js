/**
 * Print cordis log messages to stderr.
 *
 * dsh ships NO console log exporter. `LoggerService`'s constructor registers
 * exactly one built-in exporter and it only appends to a 1000-message ring
 * buffer in memory (vendor/cordis/src/logger.ts:216-226); nothing in
 * packages/ or apps/ ever registers a sink that writes to a stream. So every
 * `ctx.logger(...).info(...)` in the harness — px-verify's included — is
 * invisible from a terminal by default, and "check the log" is not something
 * you can do without this.
 *
 * Mount it as an OVERLAY, never in the profile:
 *
 *   dsh web --patch ~/personal/px/dsh/px-log-stderr/patch.yml --no-open
 *   dsh --profile headless --patch ~/personal/px/dsh/px-log-stderr/patch.yml "<task>"
 *
 * Overlay patches apply after the profile's own layer and are persisted
 * nowhere, so a run without the flag is untouched. Output goes to stderr, not
 * stdout, so it cannot corrupt a headless run's result.
 *
 * DELIBERATELY ZERO IMPORTS. A plugin mounted from outside the profile
 * directory cannot resolve `@deepseek-ai/*` — node resolves bare specifiers
 * upward from the importing FILE, and this file lives in the px repo, not in
 * `$DSH_HOME/profiles/<name>/`. Importing cordis just for `Logger.format`
 * aborted the whole boot with ERR_MODULE_NOT_FOUND. The printf subset below
 * is the price of being mountable from anywhere.
 *
 * @module px-log-stderr
 */

export const name = 'px-log-stderr'

/** cordis's own placeholder set (vendor/cordis/src/logger.ts:49-60), colorless. */
function render(args) {
  const rest = args.slice()
  let format = rest.shift()
  if (format instanceof Error) return format.stack ?? format.message
  if (typeof format !== 'string') format = JSON.stringify(format)
  const out = format.replace(/%([a-zA-Z%])/g, (match, char) => {
    if (match === '%%') return '%'
    if (!'sdifoOcC'.includes(char)) return match
    const value = rest.shift()
    switch (char) {
      case 'c': return ''
      case 'd': case 'i': return String(Math.trunc(Number(value)))
      case 'f': return String(Number(value))
      case 'o': case 'O': return JSON.stringify(value)
      default: return String(value)
    }
  })
  const tail = rest.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
  return [out, ...tail].join(' ')
}

/**
 * @param {any} ctx - plugin context.
 * @param {{ only?: string, level?: number }} [config] - `only` is a substring
 *   match on the logger name (pass `px-verify` to see just the gate instead of
 *   the whole harness); `level` is the cordis severity ceiling (0 error,
 *   1 info, 2 warn, 3 debug), default 3.
 */
export function apply(ctx, config = {}) {
  const only = typeof config.only === 'string' && config.only !== '' ? config.only : undefined
  const level = typeof config.level === 'number' ? config.level : 3
  const exporter = {
    colors: false,
    // LOAD-BEARING. cordis decides per exporter, BEFORE calling export():
    //   targetLevel = exporter.levels?.[name] ?? exporter.levels?.default
    //               ?? logger.level ?? INFO;  if (targetLevel < level) continue
    // (vendor/cordis/src/logger.ts:152-155). Its ladder is verbosity, not
    // urgency — ERROR 0 < INFO 1 < WARN 2 < DEBUG 3 — so an exporter without
    // `levels` never even SEES a warn or a debug message, and no amount of
    // filtering inside export() can get them back.
    levels: { default: level },
    export(message) {
      if (message.level > level) return
      if (only !== undefined && !String(message.name).includes(only)) return
      const time = new Date(message.ts).toISOString().slice(11, 23)
      try {
        process.stderr.write(`${time} [${String(message.type).toUpperCase()}] ${message.name} ${render(message.args)}\n`)
      } catch {
        // A closed stderr must never take the harness down with it.
      }
    },
  }
  ctx.logger.exporter(exporter)
  ctx.logger(name).info('stderr log exporter attached%s', only === undefined ? '' : ` (only: ${only})`)
}
