// Writes a synthetic IFC4 building: storeys of walls, each with one opening and a property set.
// usage: node make-stress.mjs <walls> <out.ifc>
import { createWriteStream } from 'node:fs';

const walls = Number(process.argv[2]);
const out = createWriteStream(process.argv[3]);
const perStorey = 200;
let id = 0;
const next = () => ++id;
const guid = (n) => n.toString(36).padStart(22, '0');
const lines = [];
const flush = async () => {
  if (!out.write(lines.join('\n') + '\n')) await new Promise((done) => out.once('drain', done));
  lines.length = 0;
};
const put = (text) => {
  const n = next();
  lines.push(`#${n}=${text};`);
  return n;
};

lines.push(
  'ISO-10303-21;',
  "HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('stress.ifc','2026-11-01T00:00:00',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;",
  'DATA;'
);
const metre = put('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
const area = put('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
const units = put(`IFCUNITASSIGNMENT((#${metre},#${area}))`);
const origin = put('IFCCARTESIANPOINT((0.,0.,0.))');
const world = put(`IFCAXIS2PLACEMENT3D(#${origin},$,$)`);
const context = put(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#${world},$)`);
const project = put(`IFCPROJECT('${guid(id)}',$,'Stress',$,$,$,$,(#${context}),#${units})`);
const place0 = put(`IFCLOCALPLACEMENT($,#${world})`);
const site = put(`IFCSITE('${guid(id)}',$,'Site',$,$,#${place0},$,$,.ELEMENT.,$,$,$,$,$)`);
const building = put(`IFCBUILDING('${guid(id)}',$,'Building',$,$,#${place0},$,$,.ELEMENT.,$,$,$)`);
put(`IFCRELAGGREGATES('${guid(id)}',$,$,$,#${project},(#${site}))`);
put(`IFCRELAGGREGATES('${guid(id)}',$,$,$,#${site},(#${building}))`);
const up = put('IFCDIRECTION((0.,0.,1.))');
const wallProfilePlace = put(`IFCAXIS2PLACEMENT2D(${'#' + put('IFCCARTESIANPOINT((0.,0.))')},$)`);
const wallProfile = put(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${wallProfilePlace},3.8,0.25)`);
const holeProfile = put(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${wallProfilePlace},1.,1.)`);
const storeys = [];
for (let s = 0; s * perStorey < walls; s++) {
  const point = put(`IFCCARTESIANPOINT((0.,0.,${(s * 3.2).toFixed(1)}))`);
  const place = put(`IFCLOCALPLACEMENT(#${place0},${'#' + put(`IFCAXIS2PLACEMENT3D(#${point},$,$)`)})`);
  storeys.push({ id: put(`IFCBUILDINGSTOREY('${guid(id)}',$,'S${s}',$,$,#${place},$,$,.ELEMENT.,${(s * 3.2).toFixed(1)})`), place, walls: [] });
}
put(`IFCRELAGGREGATES('${guid(id)}',$,$,$,#${building},(${storeys.map((s) => '#' + s.id).join(',')}))`);

for (let w = 0; w < walls; w++) {
  const storey = storeys[Math.floor(w / perStorey)];
  const column = w % perStorey;
  const point = put(`IFCCARTESIANPOINT((${((column % 20) * 4).toFixed(1)},${(Math.floor(column / 20) * 4).toFixed(1)},0.))`);
  const place = put(`IFCLOCALPLACEMENT(#${storey.place},${'#' + put(`IFCAXIS2PLACEMENT3D(#${point},$,$)`)})`);
  const solid = put(`IFCEXTRUDEDAREASOLID(#${wallProfile},#${world},#${up},2.8)`);
  const body = put(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
  const shape = put(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${body}))`);
  const wall = put(`IFCWALL('${guid(id)}',$,'Wall ${w}',$,$,#${place},#${shape},$,.SOLIDWALL.)`);
  storey.walls.push(wall);
  const holePoint = put('IFCCARTESIANPOINT((0.,0.,0.9))');
  const holePlace = put(`IFCLOCALPLACEMENT(#${place},${'#' + put(`IFCAXIS2PLACEMENT3D(#${holePoint},$,$)`)})`);
  const holeSolid = put(`IFCEXTRUDEDAREASOLID(#${holeProfile},#${world},#${up},1.2)`);
  const holeBody = put(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${holeSolid}))`);
  const holeShape = put(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${holeBody}))`);
  const opening = put(`IFCOPENINGELEMENT('${guid(id)}',$,'Opening',$,$,#${holePlace},#${holeShape},$,.OPENING.)`);
  put(`IFCRELVOIDSELEMENT('${guid(id)}',$,$,$,#${wall},#${opening})`);
  const a = put("IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$)");
  const b = put("IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$)");
  const set = put(`IFCPROPERTYSET('${guid(id)}',$,'Pset_WallCommon',$,(#${a},#${b}))`);
  put(`IFCRELDEFINESBYPROPERTIES('${guid(id)}',$,$,$,(#${wall}),#${set})`);
  if (lines.length > 5000) await flush();
}
for (const storey of storeys) {
  put(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(id)}',$,$,$,(${storey.walls.map((w) => '#' + w).join(',')}),#${storey.id})`);
  await flush();
}
lines.push('ENDSEC;', 'END-ISO-10303-21;');
await flush();
out.end();
