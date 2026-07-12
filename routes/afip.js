const express = require("express");
const Afip = require("@afipsdk/afip.js");

function normalizarCertificado(valor) {
  return String(valor || "").replace(/\\n/g, "\n").trim();
}

module.exports = function crearAfipRouter({ fechaAfipArgentina }) {
  const router = express.Router();

  const afip = new Afip({
    CUIT: Number(process.env.AFIP_CUIT || 20920936300),
    access_token: process.env.AFIPSDK_ACCESS_TOKEN,
    cert: normalizarCertificado(process.env.AFIP_CERT),
    key: normalizarCertificado(process.env.AFIP_KEY),
    production: true
  });

  router.post("/facturar", async (req, res) => {
    try {
      const { total, doc_tipo, doc_nro } = req.body;
      const totalNumerico = Number(total);

      if (!Number.isFinite(totalNumerico) || totalNumerico <= 0) {
        return res.status(400).json({
          ok: false,
          error: "El total de la factura debe ser mayor a cero"
        });
      }

      const puntoVenta = 2;
      const tipoComprobante = 11;
      const ultimo = await afip.ElectronicBilling.getLastVoucher(
        puntoVenta,
        tipoComprobante
      );

      const data = {
        CantReg: 1,
        PtoVta: puntoVenta,
        CbteTipo: tipoComprobante,
        Concepto: 1,
        DocTipo: Number(doc_tipo || 99),
        DocNro: Number(doc_nro || 0),
        CbteDesde: ultimo + 1,
        CbteHasta: ultimo + 1,
        CbteFch: fechaAfipArgentina(),
        ImpTotal: totalNumerico,
        ImpTotConc: 0,
        ImpNeto: totalNumerico,
        ImpOpEx: 0,
        ImpIVA: 0,
        ImpTrib: 0,
        MonId: "PES",
        MonCotiz: 1
      };

      const respuesta = await afip.ElectronicBilling.createVoucher(data);

      res.json({
        ok: true,
        cae: respuesta.CAE,
        vencimiento: respuesta.CAEFchVto,
        comprobante: ultimo + 1
      });
    } catch (error) {
      console.error("ERROR AFIP:", error);

      const detalleAfip = error?.response?.data || error?.data || null;

      res.status(500).json({
        ok: false,
        error: error.message || "Error al facturar en AFIP/ARCA",
        detalle: detalleAfip
      });
    }
  });

  return router;
};
