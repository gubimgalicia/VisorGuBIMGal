import { readZip, writeZip, type ZipEntry } from './zipArchive';
import { child, children, childText, leaf, parseXml, writeXml, type XmlNode, type XmlOut } from './xmlTree';

/**
 * BCF issues (buildingSMART BCF-XML): a project's topics with their comments and viewpoints, read
 * from a `.bcf` archive of version 3.0 or 2.1 and written as 3.0. What the viewer does not use is
 * kept: other files of the archive go back out as they came in.
 */

export type Vec3 = [number, number, number];

export interface BcfComponent {
  ifcGuid?: string;
  originatingSystem?: string;
  authoringToolId?: string;
}

export interface BcfCamera {
  kind: 'perspective' | 'orthogonal';
  viewPoint: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Perspective: the vertical field of view, degrees. */
  fieldOfView?: number;
  /** Orthogonal: the view's visible height, metres. */
  viewToWorldScale?: number;
  /** Width over height. */
  aspectRatio: number;
}

export interface BcfVisibility {
  defaultVisibility: boolean;
  exceptions: BcfComponent[];
  spacesVisible: boolean;
  spaceBoundariesVisible: boolean;
  openingsVisible: boolean;
}

export interface BcfColoring {
  /** RRGGBB or RRGGBBAA, hex. */
  color: string;
  components: BcfComponent[];
}

export interface BcfBitmap {
  format: 'png' | 'jpg';
  reference: string;
  location: Vec3;
  normal: Vec3;
  up: Vec3;
  height: number;
}

export interface BcfViewpoint {
  /** Lowercase. */
  guid: string;
  index?: number;
  camera: BcfCamera | null;
  selection: BcfComponent[];
  visibility: BcfVisibility | null;
  coloring: BcfColoring[];
  lines: { start: Vec3; end: Vec3 }[];
  clippingPlanes: { location: Vec3; direction: Vec3 }[];
  bitmaps: BcfBitmap[];
  snapshot?: { bytes: Uint8Array; format: 'png' | 'jpg' };
}

export interface BcfComment {
  guid: string;
  /** ISO 8601. */
  date: string;
  author: string;
  comment?: string;
  viewpointGuid?: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
}

export interface BcfFile {
  ifcProject?: string;
  ifcSpatialStructureElement?: string;
  isExternal: boolean;
  filename?: string;
  date?: string;
  reference?: string;
}

export interface BcfDocumentReference {
  guid: string;
  documentGuid?: string;
  url?: string;
  description?: string;
}

export interface BcfTopic {
  /** Lowercase; the topic's folder in the archive. */
  guid: string;
  topicType: string;
  topicStatus: string;
  serverAssignedId?: string;
  referenceLinks: string[];
  title: string;
  priority?: string;
  index?: number;
  labels: string[];
  creationDate: string;
  creationAuthor: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  dueDate?: string;
  assignedTo?: string;
  stage?: string;
  description?: string;
  bimSnippet?: { snippetType: string; isExternal: boolean; reference: string; referenceSchema: string };
  documentReferences: BcfDocumentReference[];
  relatedTopics: string[];
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
  files: BcfFile[];
}

export interface BcfExtensions {
  topicTypes: string[];
  topicStatuses: string[];
  priorities: string[];
  topicLabels: string[];
  users: string[];
  snippetTypes: string[];
  stages: string[];
}

export interface BcfProject {
  /** As read; always written as 3.0. */
  version: string;
  project?: { projectId: string; name?: string };
  extensions: BcfExtensions;
  topics: BcfTopic[];
  /** Files of the archive the viewer does not read, by path: documents, snippets, bitmaps. */
  otherFiles: Map<string, Uint8Array>;
}

export class BcfError extends Error {}

export const emptyExtensions = (): BcfExtensions => ({
  topicTypes: [],
  topicStatuses: [],
  priorities: [],
  topicLabels: [],
  users: [],
  snippetTypes: [],
  stages: []
});

export const newGuid = (): string => crypto.randomUUID().toLowerCase();

// ------------------------------------------------------------------------------------ reading --

const utf8 = new TextDecoder('utf-8');
const xmlOf = (bytes: Uint8Array) => parseXml(utf8.decode(bytes));
const bool = (text: string | undefined, fallback: boolean) =>
  text === undefined ? fallback : text.trim() === 'true' || text.trim() === '1';

function int(text: string | undefined): number | undefined {
  const value = text === undefined ? NaN : Number(text);
  return Number.isInteger(value) ? value : undefined;
}

function vec(node: XmlNode | undefined): Vec3 | null {
  const values = ['X', 'Y', 'Z'].map((axis) => Number(childText(node, axis)));
  return node && values.every(Number.isFinite) ? (values as Vec3) : null;
}

function component(node: XmlNode): BcfComponent {
  return {
    ifcGuid: node.attrs.IfcGuid || undefined,
    originatingSystem: childText(node, 'OriginatingSystem'),
    authoringToolId: childText(node, 'AuthoringToolId')
  };
}

const components = (node: XmlNode | undefined) => children(node, 'Component').map(component);

function camera(info: XmlNode): BcfCamera | null {
  for (const [tag, kind] of [['PerspectiveCamera', 'perspective'], ['OrthogonalCamera', 'orthogonal']] as const) {
    const node = child(info, tag);
    if (!node) continue;
    const viewPoint = vec(child(node, 'CameraViewPoint'));
    const direction = vec(child(node, 'CameraDirection'));
    const up = vec(child(node, 'CameraUpVector'));
    if (!viewPoint || !direction || !up) return null;
    const aspect = Number(childText(node, 'AspectRatio'));
    const result: BcfCamera = { kind, viewPoint, direction, up, aspectRatio: aspect > 0 ? aspect : 1 };
    if (kind === 'perspective') {
      const fov = Number(childText(node, 'FieldOfView'));
      result.fieldOfView = fov > 0 && fov < 180 ? fov : 60;
    } else {
      const scale = Number(childText(node, 'ViewToWorldScale'));
      if (!(scale > 0)) return null;
      result.viewToWorldScale = scale;
    }
    return result;
  }
  return null;
}

function visualization(info: XmlNode): Omit<BcfViewpoint, 'guid' | 'index' | 'snapshot'> {
  const parts = child(info, 'Components');
  const visibility = child(parts, 'Visibility');
  // 2.1 puts the hints beside the visibility; 3.0 inside it.
  const hints = child(visibility, 'ViewSetupHints') ?? child(parts, 'ViewSetupHints');
  return {
    camera: camera(info),
    selection: components(child(parts, 'Selection')),
    visibility: visibility
      ? {
          defaultVisibility: bool(visibility.attrs.DefaultVisibility, false),
          exceptions: components(child(visibility, 'Exceptions')),
          spacesVisible: bool(hints?.attrs.SpacesVisible, false),
          spaceBoundariesVisible: bool(hints?.attrs.SpaceBoundariesVisible, false),
          openingsVisible: bool(hints?.attrs.OpeningsVisible, false)
        }
      : null,
    coloring: children(child(parts, 'Coloring'), 'Color')
      .filter((c) => /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c.attrs.Color ?? ''))
      .map((c) => ({
        color: c.attrs.Color.toUpperCase(),
        // 3.0 wraps them in Components; 2.1 does not.
        components: child(c, 'Components') ? components(child(c, 'Components')) : components(c)
      })),
    lines: children(child(info, 'Lines'), 'Line').flatMap((line) => {
      const start = vec(child(line, 'StartPoint'));
      const end = vec(child(line, 'EndPoint'));
      return start && end ? [{ start, end }] : [];
    }),
    clippingPlanes: children(child(info, 'ClippingPlanes'), 'ClippingPlane').flatMap((plane) => {
      const location = vec(child(plane, 'Location'));
      const direction = vec(child(plane, 'Direction'));
      return location && direction ? [{ location, direction }] : [];
    }),
    bitmaps: children(child(info, 'Bitmaps'), 'Bitmap').flatMap((bitmap) => {
      const format = childText(bitmap, 'Format')?.toLowerCase();
      const reference = childText(bitmap, 'Reference');
      const location = vec(child(bitmap, 'Location'));
      const normal = vec(child(bitmap, 'Normal'));
      const up = vec(child(bitmap, 'Up'));
      const height = Number(childText(bitmap, 'Height'));
      return (format === 'png' || format === 'jpg') && reference && location && normal && up && Number.isFinite(height)
        ? [{ format, reference, location, normal, up, height }]
        : [];
    })
  };
}

const list = (node: XmlNode | undefined, outer: string, inner: string) =>
  children(child(node, outer), inner)
    .map((n) => n.text.trim())
    .filter(Boolean);

/** Reads a `.bcf` archive. Throws `BcfError` or `ZipError` on one it cannot read. */
export async function readBcf(bytes: Uint8Array): Promise<BcfProject> {
  const files = await readZip(bytes);
  const used = new Set<string>();
  const take = (name: string) => {
    const found = files.get(name);
    if (found) used.add(name);
    return found;
  };
  const xml = (name: string, what: string) => {
    const found = take(name);
    if (!found) return undefined;
    try {
      return xmlOf(found);
    } catch (error) {
      throw new BcfError(`${what} (${name}) no es XML válido: ${(error as Error).message}`);
    }
  };

  const versionNode = xml('bcf.version', 'La versión');
  const version = versionNode?.attrs.VersionId?.trim();
  if (!version) throw new BcfError('No es un archivo BCF: falta bcf.version.');
  if (version !== '3.0' && version !== '2.1') throw new BcfError(`Versión de BCF no admitida: ${version}. Se leen 2.1 y 3.0.`);

  const extensionsNode = xml('extensions.xml', 'Las extensiones');
  const extensions: BcfExtensions = {
    topicTypes: list(extensionsNode, 'TopicTypes', 'TopicType'),
    topicStatuses: list(extensionsNode, 'TopicStatuses', 'TopicStatus'),
    priorities: list(extensionsNode, 'Priorities', 'Priority'),
    topicLabels: list(extensionsNode, 'TopicLabels', 'TopicLabel'),
    users: list(extensionsNode, 'Users', 'User'),
    snippetTypes: list(extensionsNode, 'SnippetTypes', 'SnippetType'),
    stages: list(extensionsNode, 'Stages', 'Stage')
  };

  const projectNode = child(xml('project.bcfp', 'El proyecto'), 'Project');
  const project = projectNode?.attrs.ProjectId
    ? { projectId: projectNode.attrs.ProjectId, name: childText(projectNode, 'Name') }
    : undefined;

  const topics: BcfTopic[] = [];
  const folders = [...files.keys()]
    .filter((name) => /^[^/]+\/markup\.bcf$/i.test(name))
    .map((name) => name.slice(0, name.indexOf('/')));
  for (const folder of folders) {
    const markup = xml(`${folder}/markup.bcf`, 'Un tema');
    const topic = child(markup, 'Topic');
    if (!markup || !topic) throw new BcfError(`El tema ${folder} no tiene Topic.`);
    const guid = (topic.attrs.Guid ?? folder).toLowerCase();

    // 3.0 keeps comments and viewpoints in the topic; 2.1 beside it.
    const commentNodes = child(topic, 'Comments') ? children(child(topic, 'Comments'), 'Comment') : children(markup, 'Comment');
    const viewpointNodes = child(topic, 'Viewpoints')
      ? children(child(topic, 'Viewpoints'), 'ViewPoint')
      : children(markup, 'Viewpoints');

    const viewpoints: BcfViewpoint[] = [];
    for (const entry of viewpointNodes) {
      const viewpointGuid = (entry.attrs.Guid ?? '').toLowerCase();
      const file = childText(entry, 'Viewpoint');
      const info = file ? xml(`${folder}/${file}`, 'Un punto de vista') : undefined;
      if (!viewpointGuid || !info) continue;
      const snapshotName = childText(entry, 'Snapshot');
      const snapshotBytes = snapshotName ? take(`${folder}/${snapshotName}`) : undefined;
      viewpoints.push({
        guid: viewpointGuid,
        index: int(childText(entry, 'Index')),
        ...visualization(info),
        snapshot: snapshotBytes
          ? { bytes: snapshotBytes, format: /\.jpe?g$/i.test(snapshotName ?? '') ? 'jpg' : 'png' }
          : undefined
      });
    }

    const snippet = child(topic, 'BimSnippet');
    topics.push({
      guid,
      topicType: topic.attrs.TopicType ?? '',
      topicStatus: topic.attrs.TopicStatus ?? '',
      serverAssignedId: topic.attrs.ServerAssignedId,
      // 2.1 writes ReferenceLink elements straight in the topic.
      referenceLinks: child(topic, 'ReferenceLinks')
        ? list(topic, 'ReferenceLinks', 'ReferenceLink')
        : children(topic, 'ReferenceLink').map((n) => n.text.trim()).filter(Boolean),
      title: childText(topic, 'Title') ?? '',
      priority: childText(topic, 'Priority'),
      index: int(childText(topic, 'Index')),
      // 3.0 nests Label elements in one Labels; 2.1 writes one Labels per label.
      labels: children(topic, 'Labels').flatMap((n) =>
        child(n, 'Label') ? children(n, 'Label').map((l) => l.text.trim()) : [n.text.trim()]
      ).filter(Boolean),
      creationDate: childText(topic, 'CreationDate') ?? '',
      creationAuthor: childText(topic, 'CreationAuthor') ?? '',
      modifiedDate: childText(topic, 'ModifiedDate'),
      modifiedAuthor: childText(topic, 'ModifiedAuthor'),
      dueDate: childText(topic, 'DueDate'),
      assignedTo: childText(topic, 'AssignedTo'),
      stage: childText(topic, 'Stage'),
      description: childText(topic, 'Description'),
      bimSnippet: snippet
        ? {
            snippetType: snippet.attrs.SnippetType ?? '',
            isExternal: bool(snippet.attrs.IsExternal, false),
            reference: childText(snippet, 'Reference') ?? '',
            referenceSchema: childText(snippet, 'ReferenceSchema') ?? ''
          }
        : undefined,
      documentReferences: children(child(topic, 'DocumentReferences'), 'DocumentReference').map((ref) => ({
        guid: (ref.attrs.Guid ?? newGuid()).toLowerCase(),
        documentGuid: childText(ref, 'DocumentGuid'),
        url: childText(ref, 'Url'),
        description: childText(ref, 'Description')
      })),
      relatedTopics: (child(topic, 'RelatedTopics') ? children(child(topic, 'RelatedTopics'), 'RelatedTopic') : children(topic, 'RelatedTopic'))
        .map((n) => (n.attrs.Guid ?? '').toLowerCase())
        .filter(Boolean),
      comments: commentNodes.map((c) => ({
        guid: (c.attrs.Guid ?? newGuid()).toLowerCase(),
        date: childText(c, 'Date') ?? '',
        author: childText(c, 'Author') ?? '',
        comment: childText(c, 'Comment'),
        viewpointGuid: child(c, 'Viewpoint')?.attrs.Guid?.toLowerCase(),
        modifiedDate: childText(c, 'ModifiedDate'),
        modifiedAuthor: childText(c, 'ModifiedAuthor')
      })),
      viewpoints: viewpoints.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity)),
      files: children(child(child(markup, 'Header'), 'Files'), 'File').map((f) => ({
        ifcProject: f.attrs.IfcProject,
        ifcSpatialStructureElement: f.attrs.IfcSpatialStructureElement,
        isExternal: bool(f.attrs.IsExternal, true),
        filename: childText(f, 'Filename'),
        date: childText(f, 'Date'),
        reference: childText(f, 'Reference')
      }))
    });
    used.add(`${folder}/markup.bcf`);
  }

  const otherFiles = new Map<string, Uint8Array>();
  for (const [name, data] of files) {
    // Version-specific files are written anew; 2.1 had no documents.xml to keep.
    if (!used.has(name) && !/\.bcfv$/i.test(name) && !/(^|\/)(bcf\.version|extensions\.(xml|xsd)|project\.bcfp)$/i.test(name)) {
      otherFiles.set(name, data);
    }
  }
  return { version, project, extensions, topics, otherFiles };
}

// ------------------------------------------------------------------------------------ writing --

const num = (value: number) => String(Object.is(value, -0) ? 0 : value);
const point = (tag: string, v: Vec3): XmlOut => ({
  tag,
  children: [leaf('X', num(v[0])), leaf('Y', num(v[1])), leaf('Z', num(v[2]))]
});
const componentOut = (c: BcfComponent): XmlOut => ({
  tag: 'Component',
  attrs: { IfcGuid: c.ifcGuid },
  children: [leaf('OriginatingSystem', c.originatingSystem), leaf('AuthoringToolId', c.authoringToolId)]
});
const listOut = (tag: string, inner: string, values: string[]): XmlOut | null =>
  values.length ? { tag, children: values.map((v) => leaf(inner, v)) } : null;

function cameraOut(c: BcfCamera): XmlOut {
  const perspective = c.kind === 'perspective';
  return {
    tag: perspective ? 'PerspectiveCamera' : 'OrthogonalCamera',
    children: [
      point('CameraViewPoint', c.viewPoint),
      point('CameraDirection', c.direction),
      point('CameraUpVector', c.up),
      perspective ? leaf('FieldOfView', num(c.fieldOfView ?? 60)) : leaf('ViewToWorldScale', num(c.viewToWorldScale ?? 1)),
      leaf('AspectRatio', num(c.aspectRatio))
    ]
  };
}

export function visualizationXml(v: BcfViewpoint): string {
  const hasComponents = v.selection.length > 0 || v.visibility || v.coloring.length > 0;
  return writeXml({
    tag: 'VisualizationInfo',
    attrs: { Guid: v.guid },
    children: [
      hasComponents && {
        tag: 'Components',
        children: [
          v.selection.length > 0 && { tag: 'Selection', children: v.selection.map(componentOut) },
          v.visibility && {
            tag: 'Visibility',
            attrs: { DefaultVisibility: v.visibility.defaultVisibility },
            children: [
              {
                tag: 'ViewSetupHints',
                attrs: {
                  SpacesVisible: v.visibility.spacesVisible,
                  SpaceBoundariesVisible: v.visibility.spaceBoundariesVisible,
                  OpeningsVisible: v.visibility.openingsVisible
                }
              },
              v.visibility.exceptions.length > 0 && { tag: 'Exceptions', children: v.visibility.exceptions.map(componentOut) }
            ]
          },
          v.coloring.length > 0 && {
            tag: 'Coloring',
            children: v.coloring
              .filter((c) => c.components.length > 0)
              .map((c) => ({ tag: 'Color', attrs: { Color: c.color }, children: [{ tag: 'Components', children: c.components.map(componentOut) }] }))
          }
        ]
      },
      // The schema needs a camera; a viewpoint read without one gets a neutral view.
      cameraOut(v.camera ?? { kind: 'perspective', viewPoint: [0, 0, 10], direction: [0, 0, -1], up: [0, 1, 0], fieldOfView: 60, aspectRatio: 1 }),
      v.lines.length > 0 && { tag: 'Lines', children: v.lines.map((l) => ({ tag: 'Line', children: [point('StartPoint', l.start), point('EndPoint', l.end)] })) },
      v.clippingPlanes.length > 0 && {
        tag: 'ClippingPlanes',
        children: v.clippingPlanes.map((p) => ({ tag: 'ClippingPlane', children: [point('Location', p.location), point('Direction', p.direction)] }))
      },
      v.bitmaps.length > 0 && {
        tag: 'Bitmaps',
        children: v.bitmaps.map((b) => ({
          tag: 'Bitmap',
          children: [leaf('Format', b.format), leaf('Reference', b.reference), point('Location', b.location), point('Normal', b.normal), point('Up', b.up), leaf('Height', num(b.height))]
        }))
      }
    ]
  });
}

// 3.0 needs both; 2.1 could leave them out.
const topicType = (t: BcfTopic) => t.topicType.trim() || 'Issue';
const topicStatus = (t: BcfTopic) => t.topicStatus.trim() || 'Open';

/** The project's extensions with every value its topics use, which 3.0 lists as the allowed ones. */
export function usedExtensions(p: BcfProject): BcfExtensions {
  const add = (values: string[], more: (string | undefined)[]) => [
    ...values,
    ...[...new Set(more.filter((v): v is string => !!v && !values.includes(v)))]
  ];
  const e = p.extensions;
  const t = p.topics;
  return {
    topicTypes: add(e.topicTypes, t.map(topicType)),
    topicStatuses: add(e.topicStatuses, t.map(topicStatus)),
    priorities: add(e.priorities, t.map((x) => x.priority)),
    topicLabels: add(e.topicLabels, t.flatMap((x) => x.labels)),
    users: add(e.users, t.flatMap((x) => [x.creationAuthor, x.modifiedAuthor, x.assignedTo, ...x.comments.flatMap((c) => [c.author, c.modifiedAuthor])])),
    snippetTypes: add(e.snippetTypes, t.map((x) => x.bimSnippet?.snippetType)),
    stages: add(e.stages, t.map((x) => x.stage))
  };
}

export function markupXml(t: BcfTopic): string {
  return writeXml({
    tag: 'Markup',
    children: [
      t.files.length > 0 && {
        tag: 'Header',
        children: [
          {
            tag: 'Files',
            children: t.files.map((f) => ({
              tag: 'File',
              attrs: { IfcProject: f.ifcProject, IfcSpatialStructureElement: f.ifcSpatialStructureElement, IsExternal: f.isExternal },
              children: [leaf('Filename', f.filename), leaf('Date', f.date), leaf('Reference', f.reference)]
            }))
          }
        ]
      },
      {
        tag: 'Topic',
        attrs: { Guid: t.guid, ServerAssignedId: t.serverAssignedId, TopicType: topicType(t), TopicStatus: topicStatus(t) },
        children: [
          listOut('ReferenceLinks', 'ReferenceLink', t.referenceLinks),
          leaf('Title', t.title),
          leaf('Priority', t.priority),
          leaf('Index', t.index),
          listOut('Labels', 'Label', t.labels),
          leaf('CreationDate', t.creationDate),
          leaf('CreationAuthor', t.creationAuthor),
          leaf('ModifiedDate', t.modifiedDate),
          leaf('ModifiedAuthor', t.modifiedAuthor),
          leaf('DueDate', t.dueDate),
          leaf('AssignedTo', t.assignedTo),
          leaf('Stage', t.stage),
          leaf('Description', t.description),
          t.bimSnippet && {
            tag: 'BimSnippet',
            attrs: { SnippetType: t.bimSnippet.snippetType, IsExternal: t.bimSnippet.isExternal },
            children: [leaf('Reference', t.bimSnippet.reference), leaf('ReferenceSchema', t.bimSnippet.referenceSchema)]
          },
          t.documentReferences.length > 0 && {
            tag: 'DocumentReferences',
            children: t.documentReferences.map((d) => ({
              tag: 'DocumentReference',
              attrs: { Guid: d.guid },
              children: [d.documentGuid ? leaf('DocumentGuid', d.documentGuid) : leaf('Url', d.url), leaf('Description', d.description)]
            }))
          },
          t.relatedTopics.length > 0 && { tag: 'RelatedTopics', children: t.relatedTopics.map((g) => ({ tag: 'RelatedTopic', attrs: { Guid: g } })) },
          t.comments.length > 0 && {
            tag: 'Comments',
            children: t.comments.map((c) => ({
              tag: 'Comment',
              attrs: { Guid: c.guid },
              children: [
                leaf('Date', c.date),
                leaf('Author', c.author),
                leaf('Comment', c.comment),
                c.viewpointGuid && { tag: 'Viewpoint', attrs: { Guid: c.viewpointGuid } },
                leaf('ModifiedDate', c.modifiedDate),
                leaf('ModifiedAuthor', c.modifiedAuthor)
              ]
            }))
          },
          t.viewpoints.length > 0 && {
            tag: 'Viewpoints',
            children: t.viewpoints.map((v) => ({
              tag: 'ViewPoint',
              attrs: { Guid: v.guid },
              children: [leaf('Viewpoint', `${v.guid}.bcfv`), v.snapshot && leaf('Snapshot', `${v.guid}.${v.snapshot.format}`), leaf('Index', v.index)]
            }))
          }
        ]
      }
    ]
  });
}

/** The project as a BCF 3.0 archive. */
export async function writeBcf(p: BcfProject, modified = new Date()): Promise<Uint8Array> {
  const text = (name: string, xml: string): ZipEntry => ({ name, data: new TextEncoder().encode(xml) });
  const e = usedExtensions(p);
  const entries: ZipEntry[] = [
    text('bcf.version', writeXml({ tag: 'Version', attrs: { VersionId: '3.0' } })),
    text(
      'extensions.xml',
      writeXml({
        tag: 'Extensions',
        children: [
          listOut('TopicTypes', 'TopicType', e.topicTypes),
          listOut('TopicStatuses', 'TopicStatus', e.topicStatuses),
          listOut('Priorities', 'Priority', e.priorities),
          listOut('TopicLabels', 'TopicLabel', e.topicLabels),
          listOut('Users', 'User', e.users),
          listOut('SnippetTypes', 'SnippetType', e.snippetTypes),
          listOut('Stages', 'Stage', e.stages)
        ]
      })
    )
  ];
  if (p.project) {
    entries.push(
      text('project.bcfp', writeXml({ tag: 'ProjectInfo', children: [{ tag: 'Project', attrs: { ProjectId: p.project.projectId }, children: [leaf('Name', p.project.name)] }] }))
    );
  }
  const written = new Set(entries.map((entry) => entry.name));
  for (const t of p.topics) {
    const folder = t.guid.toLowerCase();
    entries.push(text(`${folder}/markup.bcf`, markupXml(t)));
    for (const v of t.viewpoints) {
      entries.push(text(`${folder}/${v.guid}.bcfv`, visualizationXml(v)));
      if (v.snapshot) entries.push({ name: `${folder}/${v.guid}.${v.snapshot.format}`, data: v.snapshot.bytes });
    }
  }
  for (const entry of entries) written.add(entry.name);
  for (const [name, data] of p.otherFiles) {
    if (!written.has(name)) entries.push({ name, data });
  }
  return writeZip(entries, modified);
}
