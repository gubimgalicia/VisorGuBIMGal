# Regresión visual de planos 2D (`test/drawings/`)

Backlog D3 (`T-141`). `scripts/check-drawings.mjs` ejecuta el kernel WASM real en Node (sin navegador) sobre 28 casos de corte 2D (plantas, secciones en X e Y en ambos sentidos, cuatro cortes por plano oblicuo/inclinado/casi horizontal/hacia arriba de C21, tramas de material y marco `map` con `localToMap`) y compara cada plano con las referencias aprobadas en `test/drawings/ref/`.

## Cómo ejecutar la comprobación

```sh
npm run kernel          # compila el kernel WASM si cambió crates/
npm run test:drawings   # o: node --experimental-strip-types scripts/check-drawings.mjs
```

Para cada caso (`<case>`), el script genera el SVG y el DXF mediante `Model.startDrawing`, `Model.nextDrawingChunk`, `Sheet.addChunk`, `Sheet.generate` y `Sheet.export`, y los contrasta con:

- `test/drawings/ref/<case>.svg`: texto SVG exacto byte a byte.
- `test/drawings/ref/<case>.json`: resumen legible con número de elementos SVG por etiqueta (`svgElements`), número de contornos cerrados (`loops`), longitud total de segmentos por capa leída del DXF (`layers`), extensión de la hoja (`extents`) y códigos de diagnóstico (`diagnostics`).

Si algún caso difiere, imprime qué cambió en el resumen (por ejemplo, variación de longitud por capa, número de contornos, extensión o atributos SVG), escribe los SVG nuevos y un informe HTML comparativo lado a lado (`index.html`, antiguo frente a nuevo) en una carpeta fuera del repositorio (por defecto `<tmp>/gubim-drawings`, o `--out <carpeta>`) y termina con código de salida `1`.

## Cómo aprobar un cambio intencionado

1. Ejecutar con `--update` (opcionalmente indicando `--out <carpeta>`):
   ```sh
   node --experimental-strip-types scripts/check-drawings.mjs --update
   ```
2. Abrir el archivo `index.html` generado en la carpeta temporal (cuya ruta imprime el propio script) y revisar a ojo los SVG antiguos y nuevos junto con el resumen de capas y contornos.
3. Si el resultado visual y numérico es correcto, confirmar (`git add test/drawings/ref && git commit`) las referencias `.svg` y `.json` actualizadas.
