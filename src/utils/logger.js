const chalk = require("chalk");
const { createWriteStream, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const { randomUUID: uuid } = require("node:crypto");
const util = require("node:util");

const LEVELS = {
  fatal: 10,
  error: 20,
  warn: 30,
  info: 40,
  success: 45,
  http: 50,
  debug: 60,
  trace: 70,
};

const LEVEL_COLORS = {
  fatal: (s) => chalk.bgRed.white.bold(` ${s.toUpperCase().padEnd(7)} `),
  error: (s) => chalk.red.bold(`${s.toUpperCase().padEnd(7)}`),
  warn: (s) => chalk.hex('#FFA500').bold(`${s.toUpperCase().padEnd(7)}`),
  info: (s) => chalk.cyan.bold(`${s.toUpperCase().padEnd(7)}`),
  success: (s) => chalk.green.bold(`${s.toUpperCase().padEnd(7)}`),
  http: (s) => chalk.magenta.bold(`${s.toUpperCase().padEnd(7)}`),
  debug: (s) => chalk.hex('#9370DB').bold(`${s.toUpperCase().padEnd(7)}`),
  trace: (s) => chalk.gray.bold(`${s.toUpperCase().padEnd(7)}`),
};

const COLORS = {
  timestamp: chalk.hex('#6B7280'), // Cool gray
  name: chalk.hex('#3B82F6').bold, // Bright blue
  separator: chalk.hex('#374151'), // Dark gray
  key: chalk.hex('#10B981'), // Emerald
  value: chalk.hex('#F59E0B'), // Amber
  error: chalk.hex('#EF4444'), // Red
  success: chalk.hex('#22C55E'), // Green
  bracket: chalk.hex('#8B5CF6'), // Purple
  arrow: chalk.hex('#06B6D4'), // Cyan
};

const LEVEL_ICONS = {
  fatal: COLORS.error('💀'),
  error: COLORS.error('❌'),
  warn: chalk.hex('#FFA500')('⚠️ '),
  info: COLORS.name('ℹ️ '),
  success: COLORS.success('✅'),
  http: chalk.magenta('🌐'),
  debug: chalk.hex('#9370DB')('🔍'),
  trace: chalk.gray('👁️ '),
};

const DEFAULTS = {
  name: "app",
  level: process.env.LOG_LEVEL || "info",
  json: parseBool(process.env.LOG_JSON ?? "false"),
  colors: parseBool(process.env.LOG_COLORS ?? String(process.env.NODE_ENV !== "production")),
  logDir: process.env.LOG_DIR || null,
  icons: parseBool(process.env.LOG_ICONS ?? "true"),
  elegant: parseBool(process.env.LOG_ELEGANT ?? "true"),
  redact: [
    /authorization/i,
    /password/i,
    /token/i,
    /secret/i,
    /api[-_]?key/i,
  ],
};

function parseBool(v) {
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function formatTimestamp() {
  const now = new Date();
  const day = now.getDate().toString().padStart(2, '0');
  const month = now.toLocaleString('en', { month: 'short' });
  const year = now.getFullYear();
  const time = now.toLocaleTimeString('en-GB', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
  const dayName = now.toLocaleString('en', { weekday: 'short' });
  
  return `${time} ${dayName}, ${day} ${month} ${year}`;
}

function nowISO() {
  return new Date().toISOString();
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function safeInspect(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function redact(value, patterns) {
  if (!patterns || patterns.length === 0) return value;

  const seen = new WeakSet();
  function _walk(v) {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      if (Array.isArray(v)) return v.map(_walk);

      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const shouldRedact = patterns.some((re) => re.test(k));
        out[k] = shouldRedact ? COLORS.error("[REDACTED]") : _walk(val);
      }
      return out;
    }
    return v;
  }
  return _walk(value);
}

function formatKeyVals(obj, useColors = true) {
  if (!obj || typeof obj !== "object") return "";
  
  return Object.entries(obj)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : util.inspect(v, { 
        colors: useColors, 
        depth: 3, 
        breakLength: 120 
      });
      
      if (useColors) {
        return `${COLORS.key(k)}${COLORS.separator('=')}${COLORS.value(val)}`;
      }
      return `${k}=${val}`;
    })
    .join(" ");
}

function formatDuration(ms) {
  if (ms < 1) return chalk.green(`${(ms * 1000).toFixed(0)}μs`);
  if (ms < 10) return chalk.green(`${ms.toFixed(2)}ms`);
  if (ms < 100) return chalk.yellow(`${ms.toFixed(1)}ms`);
  if (ms < 1000) return chalk.hex('#FFA500')(`${ms.toFixed(0)}ms`);
  return chalk.red(`${(ms / 1000).toFixed(2)}s`);
}

class DailyFileSink {
  constructor(dir, name = "app") {
    this.dir = dir;
    this.name = name;
    this.currentDay = null;
    this.stream = null;
  }
  
  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }
  
  _openIfNeeded() {
    const today = dayKey();
    if (this.stream && this.currentDay === today) return;

    this.close();
    this.ensureDir();
    const file = join(this.dir, `${this.name}-${today}.log`);
    this.stream = createWriteStream(file, { flags: "a" });
    this.currentDay = today;
  }
  
  write(line) {
    this._openIfNeeded();
    this.stream.write(line + os.EOL);
  }
  
  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

class Logger {
  constructor(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    this.name = cfg.name;
    this.level = cfg.level in LEVELS ? cfg.level : "info";
    this.json = cfg.json;
    this.colors = cfg.colors;
    this.icons = cfg.icons;
    this.elegant = cfg.elegant;
    this.redactPatterns = cfg.redact || DEFAULTS.redact;
    this.context = { ...cfg.context };
    this.fileSink = cfg.logDir ? new DailyFileSink(cfg.logDir, this.name) : null;
  }

  setLevel(level) {
    if (LEVELS[level] === undefined) return this.warn("Unknown level", { level });
    this.level = level;
  }

  with(ctx = {}) {
    return new Logger({
      name: this.name,
      level: this.level,
      json: this.json,
      colors: this.colors,
      icons: this.icons,
      elegant: this.elegant,
      logDir: this.fileSink?.dir || null,
      redact: this.redactPatterns,
      context: { ...this.context, ...ctx },
    });
  }

  timer(label = "timer") {
    const start = process.hrtime.bigint();
    return {
      end: (msg = "completed", extra = {}) => {
        const durMs = Number(process.hrtime.bigint() - start) / 1e6;
        this.info(msg, { 
          ...extra, 
          [label]: this.colors ? formatDuration(durMs) : `${durMs.toFixed(2)}ms`
        });
        return durMs;
      },
    };
  }

  fatal(msg, meta) { this._log("fatal", msg, meta); }
  error(msg, meta) { this._log("error", msg, meta); }
  warn(msg, meta)  { this._log("warn", msg, meta); }
  info(msg, meta)  { this._log("info", msg, meta); }
  success(msg, meta) { this._log("success", msg, meta); }
  http(msg, meta)  { this._log("http", msg, meta); }
  debug(msg, meta) { this._log("debug", msg, meta); }
  trace(msg, meta) { this._log("trace", msg, meta); }

  _shouldLog(level) {
    return LEVELS[level] <= LEVELS[this.level];
  }

  _serialize(level, msg, meta) {
    const time = this.elegant ? formatTimestamp() : nowISO();
    const base = { time, level, name: this.name };

    const ctx = redact({ ...this.context, ...meta }, this.redactPatterns);

    if (this.json) {
      const payload = {
        ...base,
        msg: typeof msg === "string" ? msg : util.format(msg),
        ...ctx,
      };
      return JSON.stringify(payload);
    }

    const ts = this.colors ? COLORS.timestamp(`${COLORS.bracket('[')}${time}${COLORS.bracket(']')}`) : `[${time}]`;
    const icon = (this.colors && this.icons) ? LEVEL_ICONS[level] : '';
    const lvl = this.colors ? LEVEL_COLORS[level](level) : level.toUpperCase().padEnd(7);
    const name = this.colors ? COLORS.name(this.name) : this.name;
    const arrow = this.colors ? COLORS.arrow(' → ') : ' — ';

    const msgText = typeof msg === "string" ? 
      msg : 
      util.inspect(msg, { colors: this.colors, depth: 3 });

    const kv = formatKeyVals(ctx, this.colors);
    
    if (this.elegant && this.colors) {
      return kv
        ? `${ts} ${icon}${lvl}${COLORS.separator('│')}${name}${arrow}${msgText} ${COLORS.bracket('{')}${kv}${COLORS.bracket('}')}`
        : `${ts} ${icon}${lvl}${COLORS.separator('│')}${name}${arrow}${msgText}`;
    }
    
    return kv
      ? `${ts} ${lvl} ${name}${arrow}${msgText} ${kv}`
      : `${ts} ${lvl} ${name}${arrow}${msgText}`;
  }

  _log(level, msg, meta = undefined) {
    if (!this._shouldLog(level)) return;

    let extra = meta;
    if (msg instanceof Error) {
      extra = { ...(meta || {}), err: safeInspect(msg) };
      msg = msg.message;
    } else if (meta instanceof Error) {
      extra = { err: safeInspect(meta) };
    }

    const line = this._serialize(level, msg, extra);

    this._writeConsole(level, line);

    if (this.fileSink) this.fileSink.write(this._serializeForFile(level, msg, extra));
  }

  _writeConsole(level, line) {
    if (level === "error" || level === "fatal") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  _serializeForFile(level, msg, meta) {
    const time = nowISO();
    const ctx = redact({ ...this.context, ...meta }, this.redactPatterns);
    return JSON.stringify({
      time,
      level,
      name: this.name,
      msg: typeof msg === "string" ? msg : util.format(msg),
      ...ctx,
    });
  }
}

function createLogger(options = {}) {
  return new Logger(options);
}

const logger = new Logger();

function attachRequestId(headerName = "x-request-id") {
  return function reqId(req, res, next) {
    const id = req.headers[headerName] || uuid();
    req.id = String(id);
    res.setHeader(headerName, req.id);
    next();
  };
}

function requestLogger(options = {}) {
  const {
    logger: baseLogger = logger,
    skip = (req) => req.path === "/health",
  } = options;

  return function (req, res, next) {
    if (skip(req)) return next();

    const start = process.hrtime.bigint();
    const child = baseLogger.with({ reqId: req.id });

    res.on("finish", () => {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      
      const statusColor = res.statusCode >= 500 ? chalk.red : 
                         res.statusCode >= 400 ? chalk.hex('#FFA500') :
                         res.statusCode >= 300 ? chalk.yellow :
                         chalk.green;
      
      child.http("request", {
        method: chalk.bold(req.method),
        url: req.originalUrl || req.url,
        status: statusColor(res.statusCode),
        duration: formatDuration(durMs),
        size: res.getHeader("content-length") ? `${res.getHeader("content-length")}b` : undefined,
        referrer: req.get?.("referer"),
        ua: req.get?.("user-agent"),
        ip: req.ip,
      });
    });

    next();
  };
}

module.exports = logger;
module.exports.createLogger = createLogger;
module.exports.attachRequestId = attachRequestId;
module.exports.requestLogger = requestLogger;
module.exports.Logger = Logger;
module.exports.default = logger;
module.exports.COLORS = COLORS;