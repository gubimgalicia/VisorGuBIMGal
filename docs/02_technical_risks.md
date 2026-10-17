# 02 — Análisis de Riesgos Técnicos y Limitaciones

**Propósito:** Identificación de cuellos de botella no evidentes y mitigaciones obligatorias para el visor en navegador.

---

## 1. Matriz de Riesgos

| ID | Área | Riesgo | Severidad | Mitigación obligatoria |
|---|---|---|:---:|---|
| **RSK-01** | Gráficos 3D | Jitter / temblor de vértices por precisión float32 en coordenadas UTM. | **Crítica** | Aplicar *Relative-To-Center (RTC)*; centrar coordenadas de GPU en `(0,0,0)` y almacenar offset double (64 bits). |
| **RSK-02** | Despliegue | Incompatibilidad de `SharedArrayBuffer` en hosting estático. | **Alta** | Despliegue en Vercel con cabeceras `COOP: same-origin` y `COEP: credentialless`. |
| **RSK-03** | Memoria | Cierre de pestaña por Out-Of-Memory (OOM) con IFC grandes. | **Crítica** | Streaming de mallas, no retener buffers duplicados y liberar memoria en descarte de modelos. |
| **RSK-04** | CAD 2D | Limitaciones de codificación (CP1252 vs UTF-8) en DXF R12. | **Media** | Sanitizar textos no ASCII y ofrecer exportación alternativa a SVG. |
| **RSK-05** | GIS / UX | Bloqueo de CORS en mapas WMS de terceros. | **Media** | Informar visualmente del fallo y permitir continuar con la escena BIM independiente. |
| **RSK-06** | Concurrencia | Congelación de la UI por clonado profundo en Workers. | **Alta** | Uso estricto de `Transferable Objects` con semántica zero-copy en bridges de workers. |
| **RSK-07** | Hardware | Falta de soporte de WebGPU en equipos antiguos o virtualizados. | **Alta** | Detección previa con mensaje explicativo; prever adaptador fallback a WebGL / Three.js. |

---

## 2. Mitigaciones Críticas Detalladas

### RSK-01: Coordenadas Grandes y Temblor Gráfico (RTE / RTC)
- **Problema:** En proyecciones UTM (como `EPSG:25829` en Galicia), las coordenadas alcanzan $X \approx 500.000\text{ m}$ y $Y \approx 4.500.000\text{ m}$. Las matrices `float32` de la GPU pierden precisión a partir de 7 dígitos significativos, causando jitter visible al orbitar.
- **Regla:** Ningún vértice debe cargarse en la GPU con coordenadas UTM absolutas. Se calcula el centroide o pivote del modelo, se resta a los vértices al crear los buffers y se guarda el offset en 64 bits para el puente GIS.

### RSK-02: Aislamiento de Origen Cruzado (`COOP` / `COEP`)
- **Problema:** El uso de multihilo en WASM requiere `SharedArrayBuffer`, bloqueado por navegadores si faltan cabeceras de aislamiento.
- **Regla:** En `vercel.json` se aplican:
  ```json
  {
    "key": "Cross-Origin-Opener-Policy", "value": "same-origin"
  },
  {
    "key": "Cross-Origin-Embedder-Policy", "value": "credentialless"
  }
  ```
  *(Nota: Se utiliza `credentialless` para permitir cargar teselas de mapas públicos sin bloquear CORS).*

### RSK-03: Gestión de Memoria en Navegador
- **Problema:** WebAssembly de 32 bits tiene un tope teórico de 4 GB y práctico de ~1.5–2 GB por pestaña antes de que el navegador mate el proceso.
- **Regla:** No duplicar `ArrayBuffers` en memoria de JavaScript una vez transferidos al motor gráfico o parseados. Al retirar un modelo (`removeModel`), purgar el grafo de escena en GPU.
