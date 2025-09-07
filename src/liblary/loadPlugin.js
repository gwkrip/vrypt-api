const path = require("path");
const fs = require("fs");
const log = require("../utils/logger");

class PluginManager {
  constructor() {
    this.endpoints = [];
    this.routes = new Map();
    this.plugins = new Map();
    this.middleware = [];
  }
  
  withValidation(plugin) {
    return async (req, res, next) => {
      try {
        if (plugin.authentication) {
          const authResult = this.validateAuthentication(req);
          if (!authResult.valid) {
            return res.status(authResult.status).json({ 
              error: authResult.message,
              timestamp: new Date().toISOString()
            });
          }
        }

        const validationResult = this.validateParameters(plugin, req);
        if (!validationResult.valid) {
          return res.status(400).json({
            error: "Validation failed",
            details: validationResult.errors,
            timestamp: new Date().toISOString()
          });
        }

        if (plugin.rateLimit) {
          const rateLimitResult = this.checkRateLimit(req, plugin);
          if (!rateLimitResult.allowed) {
            return res.status(429).json({
              error: "Rate limit exceeded",
              retryAfter: rateLimitResult.retryAfter,
              timestamp: new Date().toISOString()
            });
          }
        }

        const timeout = plugin.timeout || 30000;
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Plugin execution timeout")), timeout);
        });

        const pluginPromise = Promise.resolve(plugin.exec(req, res, next));
        await Promise.race([pluginPromise, timeoutPromise]);

      } catch (err) {
        log.error(`❌ Error in plugin ${plugin.name}:`, {
          error: err.message,
          stack: err.stack,
          plugin: plugin.name,
          path: req.path,
          method: req.method
        });

        if (!res.headersSent) {
          res.status(500).json({
            error: "Internal server error",
            errorId: this.generateErrorId(),
            timestamp: new Date().toISOString()
          });
        }
      }
    };
  }

  validateAuthentication(req) {
    const authHeader = req.headers["authorization"];
    
    if (!authHeader) {
      return { valid: false, status: 401, message: "Authorization header is required" };
    }

    if (!authHeader.startsWith("Bearer ")) {
      return { valid: false, status: 401, message: "Invalid authorization format. Use 'Bearer <token>'" };
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return { valid: false, status: 401, message: "Token is required" };
    }

    if (token !== process.env.TOKEN) {
      return { valid: false, status: 403, message: "Invalid or expired token" };
    }

    return { valid: true };
  }

  validateParameters(plugin, req) {
    if (!plugin.parameter || plugin.parameter.length === 0) {
      return { valid: true };
    }

    const source = plugin.method?.toUpperCase() === "GET" ? req.query : req.body;
    const errors = [];

    plugin.parameter.forEach(param => {
      if (typeof param === "string") {
        if (!source[param]) {
          errors.push(`Parameter '${param}' is required`);
        }
      } else if (typeof param === "object") {
        const { name, required = true, type, min, max, pattern } = param;
        
        if (required && !source[name]) {
          errors.push(`Parameter '${name}' is required`);
          return;
        }

        const value = source[name];
        if (value !== undefined) {
          if (type && !this.validateType(value, type)) {
            errors.push(`Parameter '${name}' must be of type ${type}`);
          }

          if (min !== undefined && value.length < min) {
            errors.push(`Parameter '${name}' must be at least ${min} characters`);
          }
          if (max !== undefined && value.length > max) {
            errors.push(`Parameter '${name}' must be at most ${max} characters`);
          }

          if (pattern && !new RegExp(pattern).test(value)) {
            errors.push(`Parameter '${name}' format is invalid`);
          }
        }
      }
    });

    return { valid: errors.length === 0, errors };
  }

  validateType(value, type) {
    switch (type) {
      case "string": return typeof value === "string";
      case "number": return !isNaN(Number(value));
      case "boolean": return value === "true" || value === "false" || typeof value === "boolean";
      case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      case "url": return /^https?:\/\/.+/.test(value);
      default: return true;
    }
  }

  checkRateLimit(req, plugin) {
    if (!this.rateLimitStore) {
      this.rateLimitStore = new Map();
    }

    const key = `${req.ip}-${plugin.name}`;
    const now = Date.now();
    const { limit, window } = plugin.rateLimit;
    
    const requests = this.rateLimitStore.get(key) || [];
    const validRequests = requests.filter(time => now - time < window);
    
    if (validRequests.length >= limit) {
      const oldestRequest = Math.min(...validRequests);
      const retryAfter = Math.ceil((window - (now - oldestRequest)) / 1000);
      return { allowed: false, retryAfter };
    }

    validRequests.push(now);
    this.rateLimitStore.set(key, validRequests);
    
    return { allowed: true };
  }

  generateErrorId() {
    return Math.random().toString(36).substr(2, 9);
  }

  loadPlugin(app, file, pluginsDir) {
    const pluginPath = path.join(pluginsDir, file);
    
    delete require.cache[require.resolve(pluginPath)];

    let plugin;
    try {
      plugin = require(pluginPath);
    } catch (err) {
      log.error(`❌ Failed to load plugin ${file}:`, {
        error: err.message,
        stack: err.stack,
        file: pluginPath
      });
      return false;
    }

    const validation = this.validatePlugin(plugin, file);
    if (!validation.valid) {
      log.warn(`⚠️ Plugin ${file} is invalid:`, validation.errors);
      return false;
    }

    this.unregisterPlugin(app, file);

    try {
      this.registerRoute(app, plugin, file);
      this.plugins.set(file, plugin);
      
      this.updateEndpointsRegistry(plugin, file);
      
      log.success(`✅ Successfully registered ${plugin.method?.toUpperCase() || 'GET'} ${plugin.path} (${file})`);
      return true;
    } catch (err) {
      log.error(`❌ Failed to register plugin ${file}:`, err);
      return false;
    }
  }

  validatePlugin(plugin, file) {
    const errors = [];
    
    if (!plugin || typeof plugin !== "object") {
      errors.push("Plugin must export an object");
      return { valid: false, errors };
    }

    const { path: routePath, method = "GET", exec } = plugin;

    if (!routePath || typeof routePath !== "string") {
      errors.push("Plugin must have a valid 'path' property");
    }

    if (typeof exec !== "function") {
      errors.push("Plugin must have a valid 'exec' function");
    }

    const allowedMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    if (!allowedMethods.includes(method.toUpperCase())) {
      errors.push(`Method '${method}' is not supported. Use: ${allowedMethods.join(", ")}`);
    }

    if (routePath && !routePath.startsWith("/")) {
      errors.push("Route path must start with '/'");
    }

    return { valid: errors.length === 0, errors };
  }

  unregisterPlugin(app, file) {
    if (this.routes.has(file)) {
      const oldRoute = this.routes.get(file);
      
      if (app._router?.stack) {
        app._router.stack = app._router.stack.filter(layer => {
          return !(layer.route?.path === oldRoute.routePath && 
                  layer.route?.methods[oldRoute.method.toLowerCase()]);
        });
      }
      
      this.routes.delete(file);
      this.plugins.delete(file);
      
      this.endpoints = this.endpoints.filter(e => 
        !(e.path === oldRoute.routePath && e.method === oldRoute.method)
      );
      
      log.info(`♻️ Unregistered old route ${oldRoute.method} ${oldRoute.routePath}`);
    }
  }

  registerRoute(app, plugin, file) {
    const handler = this.withValidation(plugin);
    const method = plugin.method?.toUpperCase() || "GET";
    const routePath = plugin.path;

    const middlewareChain = [...this.middleware, handler];

    switch (method) {
      case "GET":
        app.get(routePath, ...middlewareChain);
        break;
      case "POST":
        app.post(routePath, ...middlewareChain);
        break;
      case "PUT":
        app.put(routePath, ...middlewareChain);
        break;
      case "DELETE":
        app.delete(routePath, ...middlewareChain);
        break;
      case "PATCH":
        app.patch(routePath, ...middlewareChain);
        break;
      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    this.routes.set(file, { routePath, method });
  }

  updateEndpointsRegistry(plugin, file) {
    const endpoint = {
      path: plugin.path,
      name: plugin.name || file.replace(/\.js$/, ""),
      description: plugin.description || "",
      authentication: Boolean(plugin.authentication),
      method: plugin.method?.toUpperCase() || "GET",
      tags: plugin.tags || [],
      parameter: plugin.parameter || [],
      version: plugin.version || "1.0.0",
      deprecated: Boolean(plugin.deprecated),
      rateLimit: plugin.rateLimit || null,
      timeout: plugin.timeout || 30000
    };

    this.endpoints.push(endpoint);
  }

  addMiddleware(middleware) {
    if (typeof middleware === "function") {
      this.middleware.push(middleware);
    }
  }

  async loadAllPlugins(app, pluginsDir) {
    if (!fs.existsSync(pluginsDir)) {
      log.warn(`⚠️ Plugins directory does not exist: ${pluginsDir}`);
      return { loaded: 0, failed: 0 };
    }

    const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith(".js"));
    let loaded = 0, failed = 0;

    for (const file of files) {
      try {
        const success = this.loadPlugin(app, file, pluginsDir);
        success ? loaded++ : failed++;
      } catch (err) {
        log.error(`❌ Error loading plugin ${file}:`, err);
        failed++;
      }
    }

    log.info(`📦 Plugin loading completed: ${loaded} loaded, ${failed} failed`);
    return { loaded, failed };
  }
  
  getStats() {
    return {
      totalPlugins: this.plugins.size,
      totalEndpoints: this.endpoints.length,
      methodDistribution: this.getMethodDistribution(),
      authRequiredCount: this.endpoints.filter(e => e.authentication).length,
      deprecatedCount: this.endpoints.filter(e => e.deprecated).length
    };
  }

  getMethodDistribution() {
    const distribution = {};
    this.endpoints.forEach(endpoint => {
      distribution[endpoint.method] = (distribution[endpoint.method] || 0) + 1;
    });
    return distribution;
  }

  getEndpoints(filters = {}) {
    let filtered = [...this.endpoints];

    if (filters.method) {
      filtered = filtered.filter(e => e.method === filters.method.toUpperCase());
    }
    if (filters.authenticated !== undefined) {
      filtered = filtered.filter(e => e.authentication === filters.authenticated);
    }
    if (filters.tag) {
      filtered = filtered.filter(e => e.tags.includes(filters.tag));
    }
    if (filters.deprecated !== undefined) {
      filtered = filtered.filter(e => e.deprecated === filters.deprecated);
    }

    if (filters.sortBy) {
      filtered.sort((a, b) => {
        const aVal = a[filters.sortBy];
        const bVal = b[filters.sortBy];
        return filters.sortOrder === "desc" ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      });
    }

    return filtered;
  }

  reloadPlugin(app, file, pluginsDir) {
    log.info(`🔄 Reloading plugin: ${file}`);
    return this.loadPlugin(app, file, pluginsDir);
  }

  async healthCheck() {
    const results = {};
    
    for (const [file, plugin] of this.plugins) {
      try {
        if (typeof plugin.healthCheck === "function") {
          results[file] = await plugin.healthCheck();
        } else {
          results[file] = { status: "ok", message: "No health check defined" };
        }
      } catch (err) {
        results[file] = { status: "error", message: err.message };
      }
    }
    
    return results;
  }
}

const pluginManager = new PluginManager();

module.exports = {
  PluginManager,
  loadPlugin: (app, file, pluginsDir) => pluginManager.loadPlugin(app, file, pluginsDir),
  loadAllPlugins: (app, pluginsDir) => pluginManager.loadAllPlugins(app, pluginsDir),
  withValidation: (plugin) => pluginManager.withValidation(plugin),
  getEndpoints: (filters) => pluginManager.getEndpoints(filters),
  getStats: () => pluginManager.getStats(),
  addMiddleware: (middleware) => pluginManager.addMiddleware(middleware),
  reloadPlugin: (app, file, pluginsDir) => pluginManager.reloadPlugin(app, file, pluginsDir),
  healthCheck: () => pluginManager.healthCheck()
};