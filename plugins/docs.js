module.exports = {
  path: "/docs",
  method: "GET",
  name: "docs",
  tags: ["main"],
  description: "documentation  page",
  authentication: false,
  rateLimit: { limit: 10, window: 60000 },
  timeout: 5000,
  parameter: [],
  exec: async (req, res) => {
    res.render("index", {
      title: "Plugin API Docs",
      description: "Dokumentasi interaktif untuk Plugin API",
      keywords: "API, Swagger, OpenAPI, Docs",
      url: "http://localhost:3000",
      brand: "Vrypt"
    });
  },
};