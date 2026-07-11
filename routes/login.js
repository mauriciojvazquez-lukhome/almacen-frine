const express = require("express");

/**
 * Rutas de autenticación de Almacén Frine.
 * Se inyectan las dependencias para mantener este módulo separado del servidor principal.
 */
module.exports = function crearLoginRouter({ pool, registrarActividadEmpleado }) {
  if (!pool) {
    throw new Error("El módulo login necesita una conexión pool.");
  }

  const router = express.Router();

  function vacio(valor) {
    return valor === undefined || valor === null || String(valor).trim() === "";
  }

  router.post("/login", async (req, res) => {
    try {
      const { usuario, password } = req.body || {};

      if (vacio(usuario) || vacio(password)) {
        return res.status(400).json({
          error: "Usuario y contraseña son obligatorios"
        });
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
        return res.status(401).json({
          error: "Usuario o contraseña incorrectos"
        });
      }

      const empleado = result.rows[0];

      if (typeof registrarActividadEmpleado === "function") {
        await registrarActividadEmpleado(pool, empleado.id);
      }

      empleado.ultima_actividad = new Date().toISOString();
      return res.json(empleado);
    } catch (error) {
      console.error("Error login:", error);
      return res.status(500).json({
        error: "Error al iniciar sesión"
      });
    }
  });

  return router;
};
