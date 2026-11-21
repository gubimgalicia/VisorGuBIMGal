// Writes road-20km.ifc and road-20km.expected.json: a 20 km georeferenced road from the public
// IFC 4.3 specification, with segment conventions as IfcOpenShell writes them. Expected values
// come from the design below by plane geometry, never from any engine.
// usage: node road-20km.mjs <out dir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const R = (x) => (Number.isInteger(x) ? `${x}.` : String(x));

// Horizontal design: [kind, length, radius]; arcs turn left. Heading starts at 0 (east).
const DESIGN = [
  ['line', 5000],
  ['arc', 2000, 4000],
  ['line', 5000],
  ['arc', 2000, 5000],
  ['line', 6000]
];
const LENGTH = DESIGN.reduce((sum, [, length]) => sum + length, 0);
const LATERAL = 6; // posts stand 6 m to the left of the axis
const POST = { width: 0.5, height: 1.5 };

/** Start point and heading of each segment. */
const starts = [];
{
  let [x, y, heading] = [0, 0, 0];
  for (const [kind, length, radius] of DESIGN) {
    starts.push({ x, y, heading });
    if (kind === 'line') {
      x += length * Math.cos(heading);
      y += length * Math.sin(heading);
    } else {
      const turn = length / radius;
      const [cx, cy] = [x - radius * Math.sin(heading), y + radius * Math.cos(heading)];
      heading += turn;
      [x, y] = [cx + radius * Math.sin(heading), cy - radius * Math.cos(heading)];
    }
  }
  starts.push({ x, y, heading });
}

/** Point and heading at distance s along the axis. */
function at(s) {
  let from = 0;
  for (const [index, [kind, length, radius]] of DESIGN.entries()) {
    if (s <= from + length || index === DESIGN.length - 1) {
      const { x, y, heading } = starts[index];
      const t = s - from;
      if (kind === 'line') return { x: x + t * Math.cos(heading), y: y + t * Math.sin(heading), heading };
      const [cx, cy] = [x - radius * Math.sin(heading), y + radius * Math.cos(heading)];
      const h = heading + t / radius;
      return { x: cx + radius * Math.sin(h), y: cy - radius * Math.cos(h), heading: h };
    }
    from += length;
  }
  throw new Error('unreachable');
}

const lines = [];
let next = 100;
const add = (text) => {
  const id = next++;
  lines.push(`#${id}=${text};`);
  return id;
};
let guid = 0;
const gid = () => `'2B3road20km${String(guid++).padStart(11, '0')}'`;

const origin3 = add('IFCCARTESIANPOINT((0.,0.,0.))');
const z = add('IFCDIRECTION((0.,0.,1.))');
const x = add('IFCDIRECTION((1.,0.,0.))');
const world = add(`IFCAXIS2PLACEMENT3D(#${origin3},#${z},#${x})`);
const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${world},$)`);
const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${context},$,.MODEL_VIEW.,$)`);
const axisContext = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#${context},$,.MODEL_VIEW.,$)`);
const metre = add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
const radian = add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
const units = add(`IFCUNITASSIGNMENT((#${metre},#${radian}))`);
add(`IFCPROJECT(${gid()},$,'Road 20 km',$,$,$,$,(#${context}),#${units})`);
const crs = add(`IFCPROJECTEDCRS('EPSG:25829','ETRS89 / UTM zone 29N','ETRS89',$,$,$,#${metre})`);
add(`IFCMAPCONVERSION(#${context},#${crs},536000.,4747000.,260.,1.,0.,1.)`);
const here = add(`IFCLOCALPLACEMENT($,#${world})`);

// Horizontal: IfcLine and IfcCircle parents at the origin, each placed at its segment start.
const origin2 = add('IFCCARTESIANPOINT((0.,0.))');
const east2 = add('IFCDIRECTION((1.,0.))');
const unitX = add(`IFCVECTOR(#${east2},1.)`);
const parentLine = add(`IFCLINE(#${origin2},#${unitX})`);
const parentFrame = add(`IFCAXIS2PLACEMENT2D(#${origin2},#${east2})`);
const segments = DESIGN.map(([kind, length, radius], index) => {
  const { x, y, heading } = starts[index];
  const point = add(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`);
  const direction = add(`IFCDIRECTION((${R(Math.cos(heading))},${R(Math.sin(heading))}))`);
  const placement = add(`IFCAXIS2PLACEMENT2D(#${point},#${direction})`);
  const parent = kind === 'line' ? parentLine : add(`IFCCIRCLE(#${parentFrame},${R(radius)})`);
  return add(`IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#${placement},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(length)}),#${parent})`);
});
const horizontal = add(`IFCCOMPOSITECURVE((${segments.map((id) => `#${id}`).join(',')}),.F.)`);
// Vertical: level at the datum.
const verticalStart = add(`IFCAXIS2PLACEMENT2D(#${origin2},#${east2})`);
const vertical = add(`IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#${verticalStart},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(LENGTH)}),#${parentLine})`);
const gradient = add(`IFCGRADIENTCURVE((#${vertical}),.F.,#${horizontal},$)`);
const axisRep = add(`IFCSHAPEREPRESENTATION(#${axisContext},'Axis','Curve3D',(#${gradient}))`);
const axisShape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${axisRep}))`);
const alignment = add(`IFCALIGNMENT(${gid()},$,'Axis',$,$,#${here},#${axisShape},$)`);

// Colours.
const style = (r, g, b) => {
  const colour = add(`IFCCOLOURRGB($,${R(r)},${R(g)},${R(b)})`);
  const shading = add(`IFCSURFACESTYLESHADING(#${colour},0.)`);
  return add(`IFCSURFACESTYLE($,.BOTH.,(#${shading}))`);
};
const light = style(0.62, 0.62, 0.6);
const dark = style(0.16, 0.16, 0.18);
const red = style(0.85, 0.1, 0.1);

// Courses: a 10 m base, top at the axis, and a 7 m wearing course 0.04 m thick on it.
const stations = [0, LENGTH].map((s) => {
  const expression = add(`IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(${R(s)}),$,$,$,#${gradient})`);
  return add(`IFCAXIS2PLACEMENTLINEAR(#${expression},$,$)`);
});
const course = (name, width, depth, centre, colour) => {
  const point = add(`IFCCARTESIANPOINT((0.,${R(centre)}))`);
  const frame = add(`IFCAXIS2PLACEMENT2D(#${point},$)`);
  const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${frame},${R(width)},${R(depth)})`);
  const solid = add(`IFCSECTIONEDSOLIDHORIZONTAL(#${gradient},(#${profile},#${profile}),(${stations.map((id) => `#${id}`).join(',')}))`);
  add(`IFCSTYLEDITEM(#${solid},(#${colour}),$)`);
  const rep = add(`IFCSHAPEREPRESENTATION(#${body},'Body','AdvancedSweptSolid',(#${solid}))`);
  const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  return add(`IFCCOURSE(${gid()},$,'${name}',$,$,#${here},#${shape},$,.PAVEMENT.)`);
};
const base = course('Base course', 10, 0.3, -0.15, light);
const wearing = course('Wearing course', 7, 0.04, 0.02, dark);

// Kilometre posts, 0.5 x 0.5 x 1.5 m, by linear placement 6 m to the left.
const postProfile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${parentFrame},${R(POST.width)},${R(POST.width)})`);
const postFrame = add(`IFCAXIS2PLACEMENT3D(#${origin3},$,$)`);
const postSolid = add(`IFCEXTRUDEDAREASOLID(#${postProfile},#${postFrame},#${z},${R(POST.height)})`);
add(`IFCSTYLEDITEM(#${postSolid},(#${red}),$)`);
const postRep = add(`IFCSHAPEREPRESENTATION(#${body},'Body','SweptSolid',(#${postSolid}))`);
const postShape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${postRep}))`);
const posts = [];
for (let s = 0; s <= LENGTH; s += 1000) {
  const expression = add(`IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(${R(s)}),${R(LATERAL)},$,$,#${horizontal})`);
  const linear = add(`IFCAXIS2PLACEMENTLINEAR(#${expression},$,$)`);
  const placement = add(`IFCLINEARPLACEMENT($,#${linear},$)`);
  const label = `${Math.floor(s / 1000)}+${String(s % 1000).padStart(3, '0')}`;
  const id = add(`IFCBUILDINGELEMENTPROXY(${gid()},$,'Post ${label}',$,$,#${placement},#${postShape},$,.NOTDEFINED.)`);
  const p = at(s);
  const centre = [p.x - LATERAL * Math.sin(p.heading), p.y + LATERAL * Math.cos(p.heading), POST.height / 2];
  posts.push({ id, station: s, label, centre });
}

const text = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('Generated from the public IFC 4.3 specification by road-20km.mjs. MIT OR Apache-2.0.'),'2;1');",
  "FILE_NAME('road-20km.ifc','2026-11-05T00:00:00',(''),(''),'guBIM Viewer','guBIM Viewer','');",
  "FILE_SCHEMA(('IFC4X3_ADD2'));",
  'ENDSEC;',
  'DATA;',
  ...lines,
  'ENDSEC;',
  'END-ISO-10303-21;',
  ''
].join('\n');
fs.writeFileSync(path.join(out, 'road-20km.ifc'), text);
// One record per line, so tests can read it without a JSON library. Volumes by Pappus: each
// rectangle is centred on the axis, so its centroid travels the full length.
const json = (value) => JSON.stringify(value);
const expected = [
  '{',
  ` "length": ${LENGTH},`,
  ` "mapOffset": ${json([536000, 4747000, 260])},`,
  ` "alignment": ${alignment},`,
  ` "end": ${json({ x: starts.at(-1).x, y: starts.at(-1).y, heading: starts.at(-1).heading })},`,
  ' "courses": [',
  `  ${json({ id: base, name: 'Base course', zMin: -0.3, zMax: 0, volume: 10 * 0.3 * LENGTH })},`,
  `  ${json({ id: wearing, name: 'Wearing course', zMin: 0, zMax: 0.04, volume: 7 * 0.04 * LENGTH })}`,
  ' ],',
  ' "posts": [',
  posts.map((post) => `  ${json(post)}`).join(',\n'),
  ' ]',
  '}',
  ''
].join('\n');
JSON.parse(expected);
fs.writeFileSync(path.join(out, 'road-20km.expected.json'), expected);
console.log(`${text.length} bytes, ${posts.length} posts, end (${starts.at(-1).x.toFixed(3)}, ${starts.at(-1).y.toFixed(3)}) heading ${starts.at(-1).heading}`);
