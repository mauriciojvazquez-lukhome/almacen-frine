const { app, PORT, asegurarColumnasAlmacen } = require("./context");

require("./routes/sistema");
require("./routes/login");
require("./routes/empleados");
require("./routes/categorias");
require("./routes/proveedores");
require("./routes/ia-plu");
require("./routes/productos");
require("./routes/compras");
require("./routes/caja");
require("./routes/ventas");
require("./routes/clientes");
require("./routes/reportes");
require("./routes/rrhh");
require("./routes/dashboard");
require("./routes/asistente-ia");
require("./routes/afip");
require("./routes/recetas");
require("./routes/informe-mensual");

asegurarColumnasAlmacen()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Error preparando columnas de almacén:", error);
    app.listen(PORT, () => {
      console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
    });
  });
