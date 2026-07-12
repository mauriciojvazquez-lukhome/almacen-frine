const express = require("express");

module.exports = function crearDashboardGerencialRouter({ pool, n2 }) {
  const router = express.Router();

  const fechaVenta = "((v.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const fechaCompra = "((COALESCE(c.fecha, c.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const fechaMovimiento = "((cm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const hoy = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

  const numero = (valor) => Number(valor || 0);
  const porcentaje = (actual, anterior) => anterior ? n2(((actual - anterior) / Math.abs(anterior)) * 100) : null;

  router.get("/dashboard/gerencial", async (req, res) => {
    try {
      const inicioMes = `date_trunc('month', ${hoy})::date`;
      const inicioMesAnterior = `(date_trunc('month', ${hoy}) - INTERVAL '1 month')::date`;
      const inicioMesSiguiente = `(date_trunc('month', ${hoy}) + INTERVAL '1 month')::date`;

      const [
        resumenVentas,
        resumenCostos,
        compras,
        movimientos,
        evolucion,
        categorias,
        productos,
        empleados,
        proveedores,
        stock,
        gastosDetalle
      ] = await Promise.all([
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ${fechaVenta} = ${hoy} THEN v.total ELSE 0 END),0) AS ventas_hoy,
            COUNT(*) FILTER (WHERE ${fechaVenta} = ${hoy})::int AS tickets_hoy,
            COALESCE(SUM(CASE WHEN ${fechaVenta} = (${hoy} - INTERVAL '1 day')::date THEN v.total ELSE 0 END),0) AS ventas_ayer,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente} THEN v.total ELSE 0 END),0) AS ventas_mes,
            COUNT(*) FILTER (WHERE ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente})::int AS tickets_mes,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= ${inicioMesAnterior} AND ${fechaVenta} < ${inicioMes} THEN v.total ELSE 0 END),0) AS ventas_mes_anterior,
            COUNT(*) FILTER (WHERE ${fechaVenta} >= ${inicioMesAnterior} AND ${fechaVenta} < ${inicioMes})::int AS tickets_mes_anterior
          FROM ventas v
        `),
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente}
              THEN vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0)) ELSE 0 END),0) AS cmv_mes,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= ${inicioMesAnterior} AND ${fechaVenta} < ${inicioMes}
              THEN vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0)) ELSE 0 END),0) AS cmv_mes_anterior,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente} THEN vd.cantidad ELSE 0 END),0) AS unidades_mes,
            COUNT(DISTINCT CASE WHEN ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente} THEN vd.producto_id END)::int AS productos_distintos_mes
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id = vd.venta_id
          LEFT JOIN productos p ON p.id = vd.producto_id
        `),
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ${fechaCompra} >= ${inicioMes} AND ${fechaCompra} < ${inicioMesSiguiente} THEN cd.subtotal ELSE 0 END),0) AS compras_mes,
            COALESCE(SUM(CASE WHEN ${fechaCompra} >= ${inicioMesAnterior} AND ${fechaCompra} < ${inicioMes} THEN cd.subtotal ELSE 0 END),0) AS compras_mes_anterior
          FROM compras c
          LEFT JOIN compras_detalle cd ON cd.compra_id = c.id
        `).catch(() => ({ rows: [{ compras_mes: 0, compras_mes_anterior: 0 }] })),
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ${fechaMovimiento} >= ${inicioMes} AND ${fechaMovimiento} < ${inicioMesSiguiente}
              AND cm.tipo = 'retiro' AND cm.tipo_retiro IN ('gasto_negocio','otro') THEN cm.monto ELSE 0 END),0) AS gastos_mes,
            COALESCE(SUM(CASE WHEN ${fechaMovimiento} >= ${inicioMes} AND ${fechaMovimiento} < ${inicioMesSiguiente}
              AND cm.tipo = 'retiro' AND cm.tipo_retiro IN ('sueldo_empleado','adelanto_empleado') THEN cm.monto ELSE 0 END),0) AS sueldos_mes,
            COALESCE(SUM(CASE WHEN ${fechaMovimiento} >= ${inicioMes} AND ${fechaMovimiento} < ${inicioMesSiguiente}
              AND cm.tipo = 'retiro' AND cm.tipo_retiro = 'pago_proveedor' THEN cm.monto ELSE 0 END),0) AS pagos_proveedores_mes,
            COALESCE(SUM(CASE WHEN ${fechaMovimiento} >= ${inicioMesAnterior} AND ${fechaMovimiento} < ${inicioMes}
              AND cm.tipo = 'retiro' AND cm.tipo_retiro IN ('gasto_negocio','otro') THEN cm.monto ELSE 0 END),0) AS gastos_mes_anterior,
            COALESCE(SUM(CASE WHEN ${fechaMovimiento} >= ${inicioMesAnterior} AND ${fechaMovimiento} < ${inicioMes}
              AND cm.tipo = 'retiro' AND cm.tipo_retiro IN ('sueldo_empleado','adelanto_empleado') THEN cm.monto ELSE 0 END),0) AS sueldos_mes_anterior
          FROM caja_movimientos cm
        `),
        pool.query(`
          WITH meses AS (
            SELECT generate_series(
              date_trunc('month', ${hoy}) - interval '11 months',
              date_trunc('month', ${hoy}),
              interval '1 month'
            ) AS mes
          ),
          ventas_mes AS (
            SELECT date_trunc('month', ${fechaVenta}) AS mes,
                   COALESCE(SUM(v.total),0) AS ventas,
                   COUNT(v.id)::int AS tickets
            FROM ventas v GROUP BY 1
          ),
          cmv_mes AS (
            SELECT date_trunc('month', ${fechaVenta}) AS mes,
                   COALESCE(SUM(vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0))),0) AS cmv
            FROM ventas_detalle vd
            INNER JOIN ventas v ON v.id=vd.venta_id
            LEFT JOIN productos p ON p.id=vd.producto_id
            GROUP BY 1
          ),
          compras_mes AS (
            SELECT date_trunc('month', ${fechaCompra}) AS mes,
                   COALESCE(SUM(cd.subtotal),0) AS compras
            FROM compras c LEFT JOIN compras_detalle cd ON cd.compra_id=c.id GROUP BY 1
          ),
          mov_mes AS (
            SELECT date_trunc('month', ${fechaMovimiento}) AS mes,
                   COALESCE(SUM(CASE WHEN cm.tipo='retiro' AND cm.tipo_retiro IN ('gasto_negocio','otro') THEN cm.monto ELSE 0 END),0) AS gastos,
                   COALESCE(SUM(CASE WHEN cm.tipo='retiro' AND cm.tipo_retiro IN ('sueldo_empleado','adelanto_empleado') THEN cm.monto ELSE 0 END),0) AS sueldos
            FROM caja_movimientos cm GROUP BY 1
          )
          SELECT TO_CHAR(m.mes,'MM/YYYY') AS etiqueta, m.mes,
                 COALESCE(v.ventas,0) AS ventas, COALESCE(v.tickets,0) AS tickets,
                 COALESCE(c.cmv,0) AS cmv, COALESCE(co.compras,0) AS compras,
                 COALESCE(mo.gastos,0) AS gastos, COALESCE(mo.sueldos,0) AS sueldos,
                 COALESCE(v.ventas,0)-COALESCE(c.cmv,0) AS margen_bruto,
                 COALESCE(v.ventas,0)-COALESCE(c.cmv,0)-COALESCE(mo.gastos,0)-COALESCE(mo.sueldos,0) AS resultado
          FROM meses m
          LEFT JOIN ventas_mes v ON v.mes=m.mes
          LEFT JOIN cmv_mes c ON c.mes=m.mes
          LEFT JOIN compras_mes co ON co.mes=m.mes
          LEFT JOIN mov_mes mo ON mo.mes=m.mes
          ORDER BY m.mes
        `).catch(() => ({ rows: [] })),
        pool.query(`
          SELECT COALESCE(cat.nombre,'Sin categoría') AS nombre,
                 COALESCE(SUM(vd.subtotal),0) AS total,
                 COALESCE(SUM(vd.cantidad),0) AS cantidad,
                 COALESCE(SUM(vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0))),0) AS costo,
                 COALESCE(SUM(vd.subtotal - vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0))),0) AS ganancia
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id=vd.venta_id
          LEFT JOIN productos p ON p.id=vd.producto_id
          LEFT JOIN categorias cat ON cat.id=p.categoria_id
          WHERE ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente}
          GROUP BY cat.nombre ORDER BY ganancia DESC LIMIT 10
        `),
        pool.query(`
          SELECT COALESCE(p.nombre,'Producto') AS nombre,
                 COALESCE(SUM(vd.cantidad),0) AS cantidad,
                 COALESCE(SUM(vd.subtotal),0) AS total,
                 COALESCE(SUM(vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0))),0) AS costo,
                 COALESCE(SUM(vd.subtotal - vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0))),0) AS ganancia
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id=vd.venta_id
          LEFT JOIN productos p ON p.id=vd.producto_id
          WHERE ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente}
          GROUP BY p.id,p.nombre ORDER BY ganancia DESC LIMIT 10
        `),
        pool.query(`
          SELECT COALESCE(e.nombre,'Sin empleado') AS nombre,
                 COUNT(v.id)::int AS tickets, COALESCE(SUM(v.total),0) AS total,
                 CASE WHEN COUNT(v.id)>0 THEN COALESCE(SUM(v.total),0)/COUNT(v.id) ELSE 0 END AS promedio
          FROM ventas v LEFT JOIN empleados e ON e.id=v.empleado_id
          WHERE ${fechaVenta} >= ${inicioMes} AND ${fechaVenta} < ${inicioMesSiguiente}
          GROUP BY e.id,e.nombre ORDER BY total DESC LIMIT 10
        `),
        pool.query(`
          SELECT COALESCE(pr.nombre,'Sin proveedor') AS nombre,
                 COUNT(DISTINCT c.id)::int AS compras,
                 COALESCE(SUM(cd.subtotal),0) AS total
          FROM compras c
          LEFT JOIN compras_detalle cd ON cd.compra_id=c.id
          LEFT JOIN proveedores pr ON pr.id=c.proveedor_id
          WHERE ${fechaCompra} >= ${inicioMes} AND ${fechaCompra} < ${inicioMesSiguiente}
          GROUP BY pr.id,pr.nombre ORDER BY total DESC LIMIT 10
        `).catch(() => ({ rows: [] })),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE activo=true AND stock_actual <= stock_minimo)::int AS criticos,
            COUNT(*) FILTER (WHERE activo=true AND stock_actual < 0)::int AS negativos,
            COALESCE(SUM(CASE WHEN activo=true THEN stock_actual * (COALESCE(costo,0) / NULLIF(COALESCE(cantidad_bulto,1),0)) ELSE 0 END),0) AS capital_stock
          FROM productos
        `),
        pool.query(`
          SELECT COALESCE(NULLIF(TRIM(cm.motivo),''),'Sin detalle') AS concepto,
                 COALESCE(SUM(cm.monto),0) AS total,
                 COUNT(*)::int AS movimientos
          FROM caja_movimientos cm
          WHERE ${fechaMovimiento} >= ${inicioMes} AND ${fechaMovimiento} < ${inicioMesSiguiente}
            AND cm.tipo='retiro' AND cm.tipo_retiro IN ('gasto_negocio','otro')
          GROUP BY 1 ORDER BY total DESC LIMIT 8
        `).catch(() => ({ rows: [] }))
      ]);

      const v = resumenVentas.rows[0] || {};
      const c = resumenCostos.rows[0] || {};
      const co = compras.rows[0] || {};
      const m = movimientos.rows[0] || {};
      const st = stock.rows[0] || {};

      const ventasHoy = numero(v.ventas_hoy);
      const ticketsHoy = numero(v.tickets_hoy);
      const ventasMes = numero(v.ventas_mes);
      const ventasAnterior = numero(v.ventas_mes_anterior);
      const ticketsMes = numero(v.tickets_mes);
      const ticketsAnterior = numero(v.tickets_mes_anterior);
      const cmvMes = numero(c.cmv_mes);
      const cmvAnterior = numero(c.cmv_mes_anterior);
      const margenBruto = ventasMes - cmvMes;
      const margenBrutoAnterior = ventasAnterior - cmvAnterior;
      const gastosMes = numero(m.gastos_mes);
      const sueldosMes = numero(m.sueldos_mes);
      const gastosAnterior = numero(m.gastos_mes_anterior);
      const sueldosAnterior = numero(m.sueldos_mes_anterior);
      const resultadoNeto = margenBruto - gastosMes - sueldosMes;
      const resultadoAnterior = margenBrutoAnterior - gastosAnterior - sueldosAnterior;
      const comprasMes = numero(co.compras_mes);
      const comprasAnterior = numero(co.compras_mes_anterior);
      const margenPct = ventasMes ? (margenBruto / ventasMes) * 100 : 0;
      const margenPctAnterior = ventasAnterior ? (margenBrutoAnterior / ventasAnterior) * 100 : 0;

      const alertas = [];
      const varVentas = porcentaje(ventasMes, ventasAnterior);
      const varResultado = porcentaje(resultadoNeto, resultadoAnterior);
      const varCompras = porcentaje(comprasMes, comprasAnterior);
      const varGastos = porcentaje(gastosMes + sueldosMes, gastosAnterior + sueldosAnterior);

      if (varVentas !== null) alertas.push({ tipo: varVentas >= 0 ? 'ok' : 'peligro', texto: `Las ventas ${varVentas >= 0 ? 'subieron' : 'bajaron'} ${Math.abs(varVentas).toFixed(1)}% respecto al mes anterior.` });
      if (margenPct < 15 && ventasMes > 0) alertas.push({ tipo: 'peligro', texto: `El margen bruto estimado es ${margenPct.toFixed(1)}%, por debajo del 15%. Revisá costos y precios.` });
      else if (margenPct >= 15) alertas.push({ tipo: 'ok', texto: `El margen bruto estimado del mes es ${margenPct.toFixed(1)}%.` });
      if (varCompras !== null && varCompras > 25) alertas.push({ tipo: 'advertencia', texto: `Las compras aumentaron ${varCompras.toFixed(1)}% frente al mes anterior.` });
      if (varGastos !== null && varGastos > 20) alertas.push({ tipo: 'advertencia', texto: `Gastos y sueldos aumentaron ${varGastos.toFixed(1)}% frente al mes anterior.` });
      if (resultadoNeto < 0) alertas.push({ tipo: 'peligro', texto: 'El resultado estimado del mes es negativo después de costo de mercadería, gastos y sueldos.' });
      else if (ventasMes > 0) alertas.push({ tipo: 'ok', texto: `El resultado estimado del mes es positivo: $ ${n2(resultadoNeto).toLocaleString('es-AR')}.` });
      if (numero(st.criticos) > 0) alertas.push({ tipo: 'advertencia', texto: `Hay ${numero(st.criticos)} productos en stock crítico; ${numero(st.negativos)} tienen stock negativo.` });
      if (!alertas.length) alertas.push({ tipo: 'ok', texto: 'No hay alertas gerenciales importantes con los datos disponibles.' });

      res.json({
        kpis: {
          ventas_hoy: n2(ventasHoy), tickets_hoy: ticketsHoy,
          promedio_ticket_hoy: ticketsHoy ? n2(ventasHoy / ticketsHoy) : 0,
          ventas_mes: n2(ventasMes), ventas_mes_anterior: n2(ventasAnterior),
          tickets_mes: ticketsMes, tickets_mes_anterior: ticketsAnterior,
          ticket_promedio_mes: ticketsMes ? n2(ventasMes / ticketsMes) : 0,
          compras_mes: n2(comprasMes), compras_mes_anterior: n2(comprasAnterior),
          cmv_mes: n2(cmvMes), cmv_mes_anterior: n2(cmvAnterior),
          margen_bruto_mes: n2(margenBruto), margen_bruto_anterior: n2(margenBrutoAnterior),
          margen_pct: n2(margenPct), margen_pct_anterior: n2(margenPctAnterior),
          gastos_mes: n2(gastosMes), sueldos_mes: n2(sueldosMes),
          pagos_proveedores_mes: n2(m.pagos_proveedores_mes),
          gastos_mes_anterior: n2(gastosAnterior), sueldos_mes_anterior: n2(sueldosAnterior),
          resultado_neto_mes: n2(resultadoNeto), resultado_neto_anterior: n2(resultadoAnterior),
          unidades_mes: n2(c.unidades_mes), productos_distintos_mes: numero(c.productos_distintos_mes),
          stock_critico: numero(st.criticos), stock_negativo: numero(st.negativos), capital_stock: n2(st.capital_stock)
        },
        comparativos: {
          ventas_pct: varVentas, resultado_pct: varResultado,
          compras_pct: varCompras, gastos_pct: varGastos
        },
        evolucion_12_meses: evolucion.rows.map(r => ({
          etiqueta: r.etiqueta, ventas: n2(r.ventas), compras: n2(r.compras), cmv: n2(r.cmv),
          margen_bruto: n2(r.margen_bruto), gastos: n2(r.gastos), sueldos: n2(r.sueldos), resultado: n2(r.resultado), tickets: numero(r.tickets)
        })),
        categorias: categorias.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), costo:n2(r.costo), ganancia:n2(r.ganancia), cantidad:numero(r.cantidad) })),
        productos: productos.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), costo:n2(r.costo), ganancia:n2(r.ganancia), cantidad:numero(r.cantidad) })),
        empleados: empleados.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), tickets:numero(r.tickets), promedio:n2(r.promedio) })),
        proveedores: proveedores.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), compras:numero(r.compras) })),
        gastos_detalle: gastosDetalle.rows.map(r => ({ concepto:r.concepto, total:n2(r.total), movimientos:numero(r.movimientos) })),
        alertas,
        nota_costos: 'La rentabilidad es estimada con el costo actual guardado en cada producto. Las compras se muestran aparte porque aumentan stock y no se descuentan nuevamente del resultado.'
      });
    } catch (error) {
      console.error('Error dashboard gerencial etapa 2:', error);
      res.status(500).json({ error: 'Error al cargar Dashboard Gerencial', detalle: error.message });
    }
  });

  return router;
};
