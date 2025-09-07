require("dotenv").config();
const cluster = require("cluster");
const os = require("os");
const cfonts = require("cfonts");
const logger = require("./src/utils/logger");

const clusterLog = logger.createLogger({
  name: "cluster-service",
  level: "debug",
  json: false,
  colors: true,
  logDir: "./logs/cluster",
  context: {
    service: "cluster",
    version: "1.0.0",
  },
});

const getSystemInfo = () => {
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const usedMem = (totalMem - freeMem).toFixed(2);
  const memUsage = ((usedMem / totalMem) * 100).toFixed(1);
  
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    totalMemory: `${totalMem}GB`,
    usedMemory: `${usedMem}GB (${memUsage}%)`,
    freeMemory: `${freeMem}GB`,
    cpuCores: os.cpus().length,
    uptime: `${(os.uptime() / 3600).toFixed(1)}h`,
    loadAvg: os.loadavg().map(load => load.toFixed(2)).join(', ')
  };
};

const displayStartupBanner = () => {
  console.clear();
  
  cfonts.say("VRYPT", {
    font: "block",
    colors: ["blue"],
    space: false,
    align: "center"
  });

  cfonts.say("High Performance Cluster Service", {
    font: "console",
    color: "cyan",
    align: "center",
    space: false
  });
  
  console.log("\n" + "=".repeat(80));
  console.log("🚀 SYSTEM INITIALIZATION".padStart(50));
  console.log("=".repeat(80) + "\n");
  
  const sysInfo = getSystemInfo();
  const startTime = new Date().toLocaleString();
  
  const infoTable = [
    ["🖥️  Platform", `${sysInfo.platform} (${sysInfo.arch})`],
    ["🏠 Hostname", sysInfo.hostname],
    ["🟢 Node.js", sysInfo.nodeVersion],
    ["💾 Memory", `${sysInfo.totalMemory} total, ${sysInfo.usedMemory} used`],
    ["⚡ CPU Cores", `${sysInfo.cpuCores} cores available`],
    ["📊 Load Average", sysInfo.loadAvg],
    ["⏱️  System Uptime", sysInfo.uptime],
    ["🕒 Started At", startTime],
    ["🔧 Environment", process.env.NODE_ENV || "development"],
    ["📁 Working Dir", process.cwd()]
  ];
  
  infoTable.forEach(([key, value]) => {
    console.log(`${key.padEnd(20)} : ${value}`);
  });
  
  console.log("\n" + "=".repeat(80));
  console.log("⚙️  CLUSTER CONFIGURATION".padStart(52));
  console.log("=".repeat(80) + "\n");
};

if (cluster.isMaster) {
  displayStartupBanner();
  
  const numCPUs = parseInt(process.env.WORKERS, 10) || os.cpus().length || 1;
  const maxWorkers = Math.min(numCPUs, os.cpus().length);
  let current = 0;
  let workerStats = {
    started: 0,
    failed: 0,
    restarted: 0
  };

  console.log(`🎯 Target Workers    : ${numCPUs}`);
  console.log(`🔢 Available CPUs    : ${os.cpus().length}`);
  console.log(`📋 Strategy          : Series Mode (Failover)`);
  console.log(`🆔 Master PID        : ${process.pid}`);
  console.log(`📝 Log Directory     : ./logs/cluster`);
  console.log(`🔄 Auto Restart      : ${numCPUs < os.cpus().length ? 'Enabled' : 'Limited'}`);
  
  console.log("\n" + "-".repeat(80));
  console.log("🚀 STARTING WORKERS".padStart(48));
  console.log("-".repeat(80) + "\n");

  clusterLog.info(`Master ${process.pid} initializing cluster`, { 
    workers: numCPUs,
    strategy: "series-failover",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });

  const startWorker = () => {
    if (current < numCPUs) {
      current++;
      const startTime = Date.now();
      
      clusterLog.info(`⏳ [${current}/${numCPUs}] Forking worker...`);
      clusterLog.info(`Forking worker ${current}/${numCPUs}`, {
        workerId: current,
        timestamp: new Date().toISOString()
      });
      
      const worker = cluster.fork({ WORKER_ID: current });
      
      worker.on("online", () => {
        const bootTime = Date.now() - startTime;
        workerStats.started++;
        clusterLog.success(`✅ [${current}/${numCPUs}] Worker ${worker.process.pid} online (${bootTime}ms)`);
        clusterLog.info(`Worker online`, {
          pid: worker.process.pid,
          workerId: current,
          bootTime: `${bootTime}ms`
        });
      });

      worker.on("exit", (code, signal) => {
        const exitTime = new Date().toISOString();
        workerStats.failed++;
        
        clusterLog.error(`❌ [${current}/${numCPUs}] Worker ${worker.process.pid} exited (Code: ${code}, Signal: ${signal})`);
        clusterLog.error("Worker exited", {
          pid: worker.process.pid,
          code,
          signal,
          workerId: current,
          exitTime,
          stats: workerStats
        });

        if (current < numCPUs) {
          workerStats.restarted++;
          clusterLog.warn(`🔄 [${current + 1}/${numCPUs}] Starting replacement worker...`);
          clusterLog.warn("Starting next worker", { 
            nextWorker: current + 1,
            totalRestarts: workerStats.restarted 
          });
          setTimeout(startWorker, 1000);
        } else {
          clusterLog.warn(`⚠️  All ${numCPUs} workers exhausted. No more automatic restarts.`);
          clusterLog.warn("All workers exhausted", { 
            totalWorkers: numCPUs,
            stats: workerStats 
          });
          
          console.log("\n" + "=".repeat(80));
          console.log("📊 FINAL WORKER STATISTICS".padStart(53));
          console.log("=".repeat(80));
          console.log(`Started   : ${workerStats.started}`);
          console.log(`Failed    : ${workerStats.failed}`);
          console.log(`Restarted : ${workerStats.restarted}`);
          console.log("=".repeat(80) + "\n");
        }
      });
    }
  };

  startWorker();

  const shutdown = () => {
    console.log("\n" + "=".repeat(80));
    console.log("🛑 GRACEFUL SHUTDOWN INITIATED".padStart(55));
    console.log("=".repeat(80));
    
    clusterLog.info("Master shutting down gracefully", {
      activeWorkers: Object.keys(cluster.workers).length,
      stats: workerStats,
      shutdownTime: new Date().toISOString()
    });

    const workers = Object.keys(cluster.workers);
    clusterLog.info(`📋 Terminating ${workers.length} active workers...`);
    
    workers.forEach((id, index) => {
      const worker = cluster.workers[id];
      clusterLog.info(`⏳ [${index + 1}/${workers.length}] Terminating worker ${worker.process.pid}...`);
      worker.process.kill("SIGTERM");
    });
    
    setTimeout(() => {
      clusterLog.success("✅ Shutdown completed");
      console.log("=".repeat(80) + "\n");
      process.exit(0);
    }, 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  
  process.on("uncaughtException", (err) => {
    clusterLog.error("💥 Uncaught Exception:", err.message);
    clusterLog.error("Uncaught exception in master", { error: err.message, stack: err.stack });
    shutdown();
  });

} else {
  const workerId = process.env.WORKER_ID;
  const startTime = Date.now();
  
  try {
    require("./server.js");
    const bootTime = Date.now() - startTime;
    
    clusterLog.success(`🟢 Worker ${workerId} (PID: ${process.pid}) ready (${bootTime}ms)`);
    logger.success(`Worker started successfully`, { 
      pid: process.pid, 
      workerId: workerId,
      bootTime: `${bootTime}ms`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    clusterLog.error(`🔴 Worker ${workerId} (PID: ${process.pid}) failed to start:`, error.message);
    logger.error(`Worker failed to start`, { 
      pid: process.pid, 
      workerId: workerId,
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}