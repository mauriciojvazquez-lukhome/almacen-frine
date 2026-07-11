/**
 * Rutas de autenticación de Almacén Frine.
 *
 * Este módulo conserva exactamente el comportamiento del login original,
 * pero lo separa del index.js para comenzar la modularización de forma segura.
 */
module.exports = function registrarRutasLogin(app, dependencias) {
  const { pool, vacio, registrarActividadEmpleado } = dependencias;

  if (!app || !pool || typeof vacio !== "function" || typeof registrarActividadEmpleado !== "function") {
    throw new Error("No se pudieron inicializar las rutas de login: faltan dependencias");
  }

  app.post("/api/login", async (req, res) => {
    try {
      const { usuario, password } = req.body;

      if (vacio(usuario) || vacio(password)) {
        return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
      }

      const result = await pool.query(
        `
        SELECT
          id,
          nombre,
          usuario,
          rol,
          activo,
          puede_inicio,
          puede_ventas,
          puede_productos,
          puede_compras,
          puede_recetas,
          puede_caja,
          puede_reportes,
          puede_configuracion
        FROM empleados
        WHERE usuario = $1
          AND password = $2
          AND activo = true
        LIMIT 1
        `,
        [String(usuario).trim(), String(password).trim()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
      }

      await registrarActividadEmpleado(pool, result.rows[0].id);
      result.rows[0].ultima_actividad = new Date().toISOString();

      return res.json(result.rows[0]);
    } catch (error) {
      console.error("Error login:", error);
      return res.status(500).json({ error: "Error al iniciar sesión" });
    }
  });
};
