const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const cluster = require("cluster");
const os = require("os");
const logger = require("./src/utils/logger");
const { loadAllPlugins, addMiddleware, getEndpoints, getStats, healthCheck } = require("./src/liblary/loadPlugin");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const expressLayouts = require("express-ejs-layouts");
const { version } = require("./package.json");

class ApplicationServer {
  constructor(options = {}) {
    this.options = {
      port: process.env.PORT || 3000,
      env: process.env.NODE_ENV || 'development',
      clustered: process.env.CLUSTER_MODE === 'true',
      pluginsDir: options.pluginsDir || path.join(__dirname, "plugins"),
      logDir: options.logDir || './logs/app',
      gracefulShutdownTimeout: 30000,
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: 30000
      },
      metrics: {
        enabled: true,
        path: '/metrics'
      },
      ...options
    };

    this.app = express();
    this.server = null;
    this.isShuttingDown = false;
    this.connections = new Set();
    this.pluginWatchers = new Map();
    
    this.initializeLogger();
    this.setupGracefulShutdown();
  }

  initializeLogger() {
    this.appLog = logger.createLogger({
      name: 'app-service',
      level: this.options.env === 'development' ? 'debug' : 'info',
      json: this.options.env === 'production',
      colors: this.options.env === 'development',
      logDir: this.options.logDir,
      context: {
        service: 'app',
        version: version,
        env: this.options.env,
        pid: process.pid
      }
    });
  }

  setupGracefulShutdown() {
    const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGUSR2'];
    shutdownSignals.forEach(signal => {
      process.on(signal, () => this.gracefulShutdown(signal));
    });

    process.on('uncaughtException', (error) => {
      this.appLog.fatal('Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.appLog.fatal('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  async gracefulShutdown(signal) {
    if (this.isShuttingDown) return;
    
    this.appLog.info(`Received ${signal}. Starting graceful shutdown...`);
    this.isShuttingDown = true;

    if (this.server) {
      this.server.close(() => {
        this.appLog.info('HTTP server closed');
      });
    }

    this.connections.forEach(connection => connection.destroy());

    this.pluginWatchers.forEach(watcher => watcher.close());

    setTimeout(() => {
      this.appLog.warn('Forcing shutdown due to timeout');
      process.exit(1);
    }, this.options.gracefulShutdownTimeout);

    this.appLog.info('Graceful shutdown completed');
    process.exit(0);
  }

  setupMiddlewares() {
    this.app.use(helmet({
      contentSecurityPolicy: this.options.env === 'production',
      crossOriginEmbedderPolicy: false
    }));

    this.app.use(cors({
      origin: this.getCorsOrigins(),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Version'],
      exposedHeaders: ['X-Rate-Limit-Remaining', 'X-Rate-Limit-Reset']
    }));

    this.app.use(express.json({ 
      limit: '10mb',
      verify: (req, res, buf, encoding) => {
        req.rawBody = buf;
      }
    }));
    this.app.use(express.urlencoded({ 
      extended: true, 
      limit: '10mb' 
    }));
    
    this.app.use(cookieParser());
    this.app.use(compression({
      filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
      },
      level: 6
    }));
    this.app.use(hpp({ whitelist: ['tags'] }));

    if (this.options.env === 'production') {
      this.app.set('trust proxy', 1);
    }

    this.app.set("views", path.join(__dirname, "views"));
    this.app.set("view engine", "ejs");
    this.app.set("json spaces", this.options.env === 'development' ? 2 : 0);

    this.app.use(expressLayouts);
    this.app.use((req, res, next) => {
      req.id = this.generateRequestId();
      res.setHeader('X-Request-ID', req.id);
      next();
    });

    this.app.use(morgan(this.getMorganFormat(), { 
      stream: { 
        write: (message) => this.appLog.info(message.trim()) 
      },
      skip: (req) => {
        return this.options.env === 'production' && req.path === this.options.healthCheck.path;
      }
    }));

    this.setupRateLimiting();

    this.app.use(this.trackRequest.bind(this));
    
    this.app.use('/api/v:version', (req, res, next) => {
      if (req.params.version) {
        const version = parseInt(req.params.version);
        if (!isNaN(version)) {
          req.apiVersion = version;
          res.setHeader('X-API-Version', version);
        }
      }
      next();
    });

    this.app.use(/^\/api\/v(\d+)\/.*/, (req, res, next) => {
      const versionMatch = req.path.match(/^\/api\/v(\d+)/);
      if (versionMatch) {
        req.apiVersion = parseInt(versionMatch[1]);
        res.setHeader('X-API-Version', req.apiVersion);
      }
      next();
    });
  }

  getCorsOrigins() {
    if (this.options.env === 'production') {
      return process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : false;
    }
    return true;
  }

  getMorganFormat() {
    return this.options.env === 'production' 
      ? 'combined'
      : ':method :url :status :res[content-length] - :response-time ms';
  }

  setupRateLimiting() {
    const globalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: this.options.env === 'production' ? 1000 : 10000,
      message: {
        error: "Too many requests from this IP",
        retryAfter: "15 minutes"
      },
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        this.appLog.warn(`Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
          error: "Too many requests",
          retryAfter: Math.round(req.rateLimit.resetTime / 1000),
          timestamp: new Date().toISOString()
        });
      }
    });

    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      skipSuccessfulRequests: true,
      message: {
        error: "Too many authentication attempts",
        retryAfter: "15 minutes"
      }
    });

    this.app.use(globalLimiter);
    this.app.use('/auth', authLimiter);
    this.app.use('/login', authLimiter);
  }

  trackRequest(req, res, next) {
    const startTime = Date.now();
    
    this.connections.add(req.connection);
    req.connection.on('close', () => {
      this.connections.delete(req.connection);
    });

    this.appLog.debug(`[${req.id}] Request: ${req.method} ${req.originalUrl}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      referer: req.get('Referer')
    });

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      this.appLog.info(`[${req.id}] Response: ${res.statusCode} ${res.statusMessage} (${duration}ms)`, {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration,
        contentLength: res.get('content-length')
      });
    });

    next();
  }

  handleApiVersioning(req, res, next) {
    const versionMatch = req.path.match(/^\/api\/v(\d+)/);
    if (versionMatch) {
      req.apiVersion = parseInt(versionMatch[1]);
      res.setHeader('X-API-Version', req.apiVersion);
    }
    next();
  }

  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async setupPlugins() {
    try {
      this.appLog.info('Loading plugins...');
      
      addMiddleware((req, res, next) => {
        req.appLog = this.appLog;
        req.requestId = req.id;
        next();
      });

      const result = await loadAllPlugins(this.app, this.options.pluginsDir);
      
      this.appLog.info(`Plugin loading completed: ${result.loaded} loaded, ${result.failed} failed`);
      
      if (this.options.env === 'development') {
        this.setupPluginWatching();
      }

    } catch (error) {
      this.appLog.error('Failed to load plugins:', error);
      throw error;
    }
  }

  setupPluginWatching() {
    try {
      const watcher = fs.watch(
        this.options.pluginsDir,
        { recursive: true },
        (eventType, filename) => {
          if (filename && filename.endsWith(".js") && !this.isShuttingDown) {
            this.appLog.info(`🔄 Plugin file changed: ${filename}`);
            this.debouncePluginReload(filename);
          }
        }
      );

      this.pluginWatchers.set('main', watcher);
      this.appLog.info('Plugin hot reloading enabled');
    } catch (error) {
      this.appLog.warn('Failed to setup plugin watching:', error.message);
    }
  }

  debouncePluginReload(filename) {
    clearTimeout(this.pluginReloadTimeout);
    this.pluginReloadTimeout = setTimeout(async () => {
      try {
        const filePath = path.join(this.options.pluginsDir, filename);
        const { reloadPlugin } = require("./src/liblary/loadPlugin");
        await reloadPlugin(this.app, path.basename(filePath), path.dirname(filePath));
        this.appLog.info(`✅ Plugin reloaded: ${filename}`);
      } catch (error) {
        this.appLog.error(`❌ Failed to reload plugin ${filename}:`, error);
      }
    }, 1000);
  }

  setupHealthCheck() {
    if (!this.options.healthCheck.enabled) return;

    this.app.get(this.options.healthCheck.path, async (req, res) => {
      try {
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version,
          environment: this.options.env,
          pid: process.pid,
          memory: process.memoryUsage(),
          plugins: await healthCheck()
        };

        res.json(health);
      } catch (error) {
        this.appLog.error('Health check failed:', error);
        res.status(503).json({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  setupMetricsEndpoint() {
    if (!this.options.metrics.enabled) return;

    this.app.get(this.options.metrics.path, (req, res) => {
      const metrics = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        plugins: getStats(),
        endpoints: getEndpoints().length
      };

      res.json(metrics);
    });
  }

  setupApiDocumentation() {
    this.app.get('/api/docs', (req, res) => {
      const endpoints = getEndpoints();
      const documentation = {
        title: 'API Documentation',
        version,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        endpoints: endpoints.map(endpoint => ({
          ...endpoint,
          example: `${req.protocol}://${req.get('host')}${endpoint.path}`
        }))
      };

      res.json(documentation);
    });

    this.app.get('/api/openapi.json', (req, res) => {
      const endpoints = getEndpoints();
      const openApiSpec = this.generateOpenApiSpec(endpoints, req);
      res.json(openApiSpec);
    });
  }

  generateOpenApiSpec(endpoints, req) {
    const spec = {
      openapi: '3.0.0',
      info: {
        title: 'Plugin API',
        version,
        description: 'Auto-generated API documentation'
      },
      servers: [
        {
          url: `${req.protocol}://${req.get('host')}`,
          description: 'Current server'
        }
      ],
      paths: {}
    };

    endpoints.forEach(endpoint => {
      if (!spec.paths[endpoint.path]) {
        spec.paths[endpoint.path] = {};
      }

      spec.paths[endpoint.path][endpoint.method.toLowerCase()] = {
        summary: endpoint.name,
        description: endpoint.description,
        tags: endpoint.tags,
        parameters: endpoint.parameter.map(param => ({
          name: typeof param === 'string' ? param : param.name,
          in: endpoint.method === 'GET' ? 'query' : 'body',
          required: typeof param === 'string' ? true : param.required,
          schema: {
            type: typeof param === 'string' ? 'string' : param.type || 'string'
          }
        })),
        responses: {
          '200': {
            description: 'Success'
          },
          '400': {
            description: 'Bad Request'
          },
          '401': {
            description: 'Unauthorized'
          },
          '500': {
            description: 'Internal Server Error'
          }
        }
      };

      if (endpoint.authentication) {
        spec.paths[endpoint.path][endpoint.method.toLowerCase()].security = [
          { bearerAuth: [] }
        ];
      }
    });

    if (endpoints.some(e => e.authentication)) {
      spec.components = {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer'
          }
        }
      };
    }

    return spec;
  }

  setupErrorHandling() {
    this.app.use((req, res, next) => {
      const error = {
        error: "Resource not found",
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
        requestId: req.id
      };
      
      this.appLog.warn(`404 - ${req.method} ${req.originalUrl}`, { ip: req.ip });
      res.status(404).json(error);
    });

    this.app.use((err, req, res, next) => {
      const errorId = this.generateRequestId();
      
      this.appLog.error(`[${errorId}] Unhandled error in ${req.method} ${req.originalUrl}:`, {
        error: err.message,
        stack: err.stack,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      if (res.headersSent) {
        return next(err);
      }

      const errorResponse = {
        error: "Internal Server Error",
        errorId,
        timestamp: new Date().toISOString()
      };

      if (this.options.env === 'development') {
        errorResponse.details = err.message;
        errorResponse.stack = err.stack;
      }

      res.status(err.status || 500).json(errorResponse);
    });
  }

  async initialize() {
    try {
      this.appLog.info(`Initializing application server v${version} in ${this.options.env} mode`);
      
      this.setupMiddlewares();
      
      await this.setupPlugins();
      
      this.setupHealthCheck();
      this.setupMetricsEndpoint();
      this.setupApiDocumentation();
      
      this.setupErrorHandling();
      
      this.appLog.info('Application server initialized successfully');
      
    } catch (error) {
      this.appLog.fatal('Failed to initialize application server:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.options.port, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        this.appLog.info(`🚀 Server running on port ${this.options.port}`);
        this.appLog.info(`📚 API Documentation: http://localhost:${this.options.port}/api/docs`);
        this.appLog.info(`❤️ Health Check: http://localhost:${this.options.port}${this.options.healthCheck.path}`);
        
        resolve(this.server);
      });
    });
  }

  static async createClusteredApp(options = {}) {
    const numCPUs = os.cpus().length;
    
    if (cluster.isMaster) {
      console.log(`🔧 Master process ${process.pid} is running`);
      console.log(`🚀 Starting ${numCPUs} workers...`);
      
      for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
      }
      
      cluster.on('exit', (worker, code, signal) => {
        console.log(`💀 Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
      });
      
    } else {
      const app = new ApplicationServer(options);
      await app.start();
      console.log(`👷 Worker ${process.pid} started`);
    }
  }
}

module.exports = ApplicationServer;
