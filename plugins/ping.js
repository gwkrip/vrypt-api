module.exports = {
  path: "/api/ping",
  method: "GET",
  name: "ping",
  description: "ngetes api ygy",
  authentication: false,
  rateLimit: { limit: 10, window: 60000 },
  timeout: 5000,
  parameter: [
    {
      name: "message",
      required: false,
      type: "text"
    },
  ],
  exec: async (req, res) => {
    const data = req.query;
    const message = data.message
    
    res.json({ success: true, msg: message || "" });
  },
  healthCheck: async () => {
    return { status: "ok", database: "connected" };
  }
};