import type {
  ElementDetails,
  SpatialNode,
  SpatialTree
} from '../../domain/kernel/KernelPort';
import type {
  AttributeValue,
  MaterialInfo,
  ModelId,
  PropertySetItem
} from '../../domain/models/ModelRecord';
import { t } from '../i18n';

export type IdsValueConstraint =
  | { kind: 'simple'; value: string }
  | {
      kind: 'restriction';
      base?: string;
      enumeration?: string[];
      pattern?: string;
      minInclusive?: number;
      maxInclusive?: number;
      minExclusive?: number;
      maxExclusive?: number;
      length?: number;
      minLength?: number;
      maxLength?: number;
    };

export type IdsCardinality = 'required' | 'prohibited' | 'optional';

export type IdsFacet =
  | {
      kind: 'entity';
      name: IdsValueConstraint;
      predefinedType?: IdsValueConstraint;
    }
  | {
      kind: 'attribute';
      cardinality: IdsCardinality;
      name: IdsValueConstraint;
      value?: IdsValueConstraint;
    }
  | {
      kind: 'property';
      cardinality: IdsCardinality;
      propertySet: IdsValueConstraint;
      baseName: IdsValueConstraint;
      value?: IdsValueConstraint;
      dataType?: string;
    }
  | {
      kind: 'material';
      cardinality: IdsCardinality;
      value?: IdsValueConstraint;
    }
  | {
      kind: 'partOf';
      cardinality: IdsCardinality;
      relation?: string;
      entityName: IdsValueConstraint;
      predefinedType?: IdsValueConstraint;
    };

export interface IdsSpecification {
  name: string;
  description?: string;
  instructions?: string;
  ifcVersion?: string;
  minOccurs?: number;
  maxOccurs?: number | 'unbounded';
  applicability: IdsFacet[];
  requirements: IdsFacet[];
}

export interface IdsDocument {
  title: string;
  specifications: IdsSpecification[];
}

export interface IdsCandidateElement {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  ifcClass: string;
  name: string;
  storey: string;
  ancestors: string[];
  details?: ElementDetails | null;
}

export interface IdsElementFailure {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  ifcClass: string;
  name: string;
  storey: string;
  reasons: string[];
}

export interface IdsSpecResult {
  name: string;
  description?: string;
  instructions?: string;
  ifcVersion?: string;
  status: 'pass' | 'fail' | 'not-applicable';
  applicableCount: number;
  passedCount: number;
  failedCount: number;
  cardinalityNote?: string;
  failures: IdsElementFailure[];
}

export interface IdsReport {
  title: string;
  totalSpecs: number;
  passedSpecs: number;
  failedSpecs: number;
  notApplicableSpecs: number;
  specifications: IdsSpecResult[];
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function unescapeXml(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function stripNs(name: string): string {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const key = stripNs(m[1]);
    const val = unescapeXml(m[2] ?? m[3] ?? '');
    attrs[key] = val;
  }
  return attrs;
}

function parseXmlTree(xml: string): XmlNode {
  const cleaned = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tokenRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<\/([a-zA-Z0-9_.:-]+)\s*>|<([a-zA-Z0-9_.:-]+)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(cleaned)) !== null) {
    const parent = stack[stack.length - 1];
    if (match.index > lastIndex) {
      const between = unescapeXml(cleaned.slice(lastIndex, match.index));
      if (between.trim()) {
        parent.text += between;
      }
    }
    lastIndex = tokenRe.lastIndex;

    if (match[1] !== undefined) {
      parent.text += match[1];
    } else if (match[2] !== undefined) {
      const closingTag = stripNs(match[2]);
      if (stack.length > 1 && stack[stack.length - 1].tag === closingTag) {
        stack.pop();
      }
    } else if (match[3] !== undefined) {
      const tag = stripNs(match[3]);
      const attrs = parseAttributes(match[4] ?? '');
      const selfClosing = match[5] === '/';
      const node: XmlNode = { tag, attrs, children: [], text: '' };
      parent.children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
    }
  }

  return root.children[0] ?? root;
}

function findChild(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  return node?.children.find((c) => c.tag === tag);
}

function findChildren(node: XmlNode | undefined, tag: string): XmlNode[] {
  return node ? node.children.filter((c) => c.tag === tag) : [];
}

function parseValueConstraint(container: XmlNode | undefined): IdsValueConstraint | undefined {
  if (!container) return undefined;
  const simple = findChild(container, 'simpleValue');
  if (simple) {
    return { kind: 'simple', value: simple.text.trim() };
  }
  const restriction = findChild(container, 'restriction');
  if (restriction) {
    const enums = findChildren(restriction, 'enumeration')
      .map((n) => n.attrs.value)
      .filter((v): v is string => v !== undefined);
    const patternNode = findChild(restriction, 'pattern');
    const minInc = findChild(restriction, 'minInclusive')?.attrs.value;
    const maxInc = findChild(restriction, 'maxInclusive')?.attrs.value;
    const minExc = findChild(restriction, 'minExclusive')?.attrs.value;
    const maxExc = findChild(restriction, 'maxExclusive')?.attrs.value;
    const len = findChild(restriction, 'length')?.attrs.value;
    const minLen = findChild(restriction, 'minLength')?.attrs.value;
    const maxLen = findChild(restriction, 'maxLength')?.attrs.value;
    return {
      kind: 'restriction',
      base: restriction.attrs.base,
      enumeration: enums.length > 0 ? enums : undefined,
      pattern: patternNode?.attrs.value,
      minInclusive: minInc !== undefined ? Number(minInc) : undefined,
      maxInclusive: maxInc !== undefined ? Number(maxInc) : undefined,
      minExclusive: minExc !== undefined ? Number(minExc) : undefined,
      maxExclusive: maxExc !== undefined ? Number(maxExc) : undefined,
      length: len !== undefined ? Number(len) : undefined,
      minLength: minLen !== undefined ? Number(minLen) : undefined,
      maxLength: maxLen !== undefined ? Number(maxLen) : undefined
    };
  }
  if (container.text.trim()) {
    return { kind: 'simple', value: container.text.trim() };
  }
  return undefined;
}

function parseCardinality(raw: string | undefined): IdsCardinality {
  if (raw === 'prohibited' || raw === 'optional') return raw;
  return 'required';
}

function parseFacet(node: XmlNode): IdsFacet | null {
  const cardinality = parseCardinality(node.attrs.cardinality);
  switch (node.tag) {
    case 'entity': {
      const name = parseValueConstraint(findChild(node, 'name'));
      if (!name) return null;
      const predefinedType = parseValueConstraint(findChild(node, 'predefinedType'));
      return { kind: 'entity', name, predefinedType };
    }
    case 'attribute': {
      const name = parseValueConstraint(findChild(node, 'name'));
      if (!name) return null;
      const value = parseValueConstraint(findChild(node, 'value'));
      return { kind: 'attribute', cardinality, name, value };
    }
    case 'property': {
      const propertySet = parseValueConstraint(findChild(node, 'propertySet'));
      const baseName = parseValueConstraint(findChild(node, 'baseName'));
      if (!propertySet || !baseName) return null;
      const value = parseValueConstraint(findChild(node, 'value'));
      return {
        kind: 'property',
        cardinality,
        propertySet,
        baseName,
        value,
        dataType: node.attrs.dataType
      };
    }
    case 'material': {
      const value = parseValueConstraint(findChild(node, 'value'));
      return { kind: 'material', cardinality, value };
    }
    case 'partOf': {
      const entityNode = findChild(node, 'entity');
      const entityName = parseValueConstraint(findChild(entityNode, 'name'));
      if (!entityName) return null;
      const predefinedType = parseValueConstraint(findChild(entityNode, 'predefinedType'));
      return {
        kind: 'partOf',
        cardinality,
        relation: node.attrs.relation,
        entityName,
        predefinedType
      };
    }
    default:
      return null;
  }
}

/**
 * Parses a buildingSMART IDS 1.0 XML string into an `IdsDocument`.
 */
export function parseIdsXml(xml: string): IdsDocument {
  const root = parseXmlTree(xml);
  const infoNode = findChild(root, 'info');
  const titleNode = findChild(infoNode, 'title');
  const specsContainer = findChild(root, 'specifications');
  const specNodes = specsContainer
    ? findChildren(specsContainer, 'specification')
    : findChildren(root, 'specification');

  const specifications: IdsSpecification[] = specNodes.map((specNode, index) => {
    const appNode = findChild(specNode, 'applicability');
    const reqNode = findChild(specNode, 'requirements');
    const applicability = (appNode?.children ?? [])
      .map(parseFacet)
      .filter((f): f is IdsFacet => f !== null);
    const requirements = (reqNode?.children ?? [])
      .map(parseFacet)
      .filter((f): f is IdsFacet => f !== null);

    const minRaw = specNode.attrs.minOccurs ?? appNode?.attrs.minOccurs;
    const maxRaw = specNode.attrs.maxOccurs ?? appNode?.attrs.maxOccurs;
    const minOccurs = minRaw !== undefined ? Number(minRaw) : undefined;
    const maxOccurs =
      maxRaw === 'unbounded'
        ? 'unbounded'
        : maxRaw !== undefined
          ? Number(maxRaw)
          : undefined;

    return {
      name: (specNode.attrs.name || t('ids.defaultSpecName', { index: index + 1 })).trim(),
      description: specNode.attrs.description?.trim(),
      instructions: specNode.attrs.instructions?.trim(),
      ifcVersion: specNode.attrs.ifcVersion?.trim(),
      minOccurs: Number.isFinite(minOccurs) ? minOccurs : undefined,
      maxOccurs: maxOccurs === 'unbounded' || Number.isFinite(maxOccurs) ? maxOccurs : undefined,
      applicability,
      requirements
    };
  });

  return {
    title: titleNode?.text.trim() || t('ids.defaultDocTitle'),
    specifications
  };
}

function normalizeEntityName(ifcClass: string): string {
  return ifcClass.trim().toUpperCase().replace(/STANDARDCASE$/, '');
}

/**
 * Checks whether a candidate scalar value satisfies an `IdsValueConstraint`.
 */
export function matchesIdsValue(
  constraint: IdsValueConstraint,
  candidate: string | number | boolean | null | undefined,
  caseInsensitiveEntity = false
): boolean {
  if (candidate === null || candidate === undefined) return false;
  const candidateStr = String(candidate);

  if (constraint.kind === 'simple') {
    if (caseInsensitiveEntity) {
      return (
        candidateStr.trim().toUpperCase() === constraint.value.trim().toUpperCase() ||
        normalizeEntityName(candidateStr) === normalizeEntityName(constraint.value)
      );
    }
    if (candidateStr === constraint.value) return true;
    const numA = Number(candidate);
    const numB = Number(constraint.value);
    if (
      candidateStr.trim() !== '' &&
      constraint.value.trim() !== '' &&
      Number.isFinite(numA) &&
      Number.isFinite(numB)
    ) {
      return Math.abs(numA - numB) <= 1e-9;
    }
    return false;
  }

  if (constraint.enumeration && constraint.enumeration.length > 0) {
    const matched = constraint.enumeration.some((item) =>
      caseInsensitiveEntity
        ? candidateStr.trim().toUpperCase() === item.trim().toUpperCase() ||
          normalizeEntityName(candidateStr) === normalizeEntityName(item)
        : candidateStr === item
    );
    if (!matched) return false;
  }

  if (constraint.pattern !== undefined) {
    try {
      const re = new RegExp(`^(?:${constraint.pattern})$`);
      if (!re.test(candidateStr)) return false;
    } catch {
      return false;
    }
  }

  if (
    constraint.minInclusive !== undefined ||
    constraint.maxInclusive !== undefined ||
    constraint.minExclusive !== undefined ||
    constraint.maxExclusive !== undefined
  ) {
    const num = typeof candidate === 'number' ? candidate : Number(candidateStr);
    if (!Number.isFinite(num)) return false;
    if (constraint.minInclusive !== undefined && num < constraint.minInclusive) return false;
    if (constraint.maxInclusive !== undefined && num > constraint.maxInclusive) return false;
    if (constraint.minExclusive !== undefined && num <= constraint.minExclusive) return false;
    if (constraint.maxExclusive !== undefined && num >= constraint.maxExclusive) return false;
  }

  if (constraint.length !== undefined && candidateStr.length !== constraint.length) return false;
  if (constraint.minLength !== undefined && candidateStr.length < constraint.minLength) return false;
  if (constraint.maxLength !== undefined && candidateStr.length > constraint.maxLength) return false;

  return true;
}

/**
 * Walks a model's `SpatialTree` and returns all primary (`via === 'contains'`) elements with
 * their enclosing `IfcBuildingStorey` name and spatial ancestor class chain.
 */
export function extractIdsCandidates(
  modelId: ModelId,
  modelName: string,
  tree: SpatialTree | undefined
): IdsCandidateElement[] {
  if (!tree) return [];
  const results: IdsCandidateElement[] = [];

  const visit = (node: SpatialNode, ancestors: string[], currentStorey: string | null) => {
    const nextAncestors = [...ancestors, node.type];
    const nextStorey =
      node.type === 'IfcBuildingStorey'
        ? node.name?.trim() || t('ids.defaultStoreyName', { id: node.expressId })
        : currentStorey;

    for (const elem of node.elements) {
      if (elem.via !== 'contains') continue;
      results.push({
        modelId,
        modelName,
        expressId: elem.expressId,
        ifcClass: elem.type,
        name: elem.name ?? '',
        storey: nextStorey ?? t('ids.noStorey'),
        ancestors: nextAncestors
      });
    }

    for (const child of node.children) {
      visit(child, nextAncestors, nextStorey);
    }
  };

  visit(tree.root, [], null);

  for (const elem of tree.unassigned) {
    if (elem.via !== 'contains') continue;
    results.push({
      modelId,
      modelName,
      expressId: elem.expressId,
      ifcClass: elem.type,
      name: elem.name ?? '',
      storey: t('ids.noStorey'),
      ancestors: []
    });
  }

  return results;
}

function unwrapAttributeScalar(val: AttributeValue | undefined): string | number | boolean | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.length > 0 ? unwrapAttributeScalar(val[0]) : null;
  if ('enum' in val) return val.enum;
  if ('value' in val) return unwrapAttributeScalar(val.value);
  return null;
}

function getElementAttribute(
  element: IdsCandidateElement,
  attrName: string
): string | number | boolean | null {
  const details = element.details;
  if (details?.attributes && attrName in details.attributes) {
    return unwrapAttributeScalar(details.attributes[attrName]);
  }
  const keyLower = attrName.toLowerCase();
  if (details?.attributes) {
    for (const [k, v] of Object.entries(details.attributes)) {
      if (k.toLowerCase() === keyLower) {
        return unwrapAttributeScalar(v);
      }
    }
  }
  if (keyLower === 'name') return details?.name ?? (element.name || null);
  if (keyLower === 'globalid') return details?.globalId ?? null;
  return null;
}

function collectMaterialNames(materials: readonly MaterialInfo[] | undefined): string[] {
  if (!materials) return [];
  const names: string[] = [];
  for (const mat of materials) {
    if (mat.name) names.push(mat.name);
    for (const layer of mat.layers ?? []) {
      if (layer.name) names.push(layer.name);
    }
    for (const prof of mat.profiles ?? []) {
      if (prof.material) names.push(prof.material);
      if (prof.name) names.push(prof.name);
    }
    for (const c of mat.constituents ?? []) {
      if (c.material) names.push(c.material);
      if (c.name) names.push(c.name);
    }
  }
  return names;
}

function describeConstraint(c: IdsValueConstraint | undefined): string {
  if (!c) return '';
  if (c.kind === 'simple') return c.value;
  if (c.enumeration) return `[${c.enumeration.join(', ')}]`;
  if (c.pattern) return `/${c.pattern}/`;
  const parts: string[] = [];
  if (c.minInclusive !== undefined) parts.push(`>= ${c.minInclusive}`);
  if (c.minExclusive !== undefined) parts.push(`> ${c.minExclusive}`);
  if (c.maxInclusive !== undefined) parts.push(`<= ${c.maxInclusive}`);
  if (c.maxExclusive !== undefined) parts.push(`< ${c.maxExclusive}`);
  return parts.join(t('ids.constraintAnd')) || t('ids.constraintFallback');
}

function checkFacetRawMatch(facet: IdsFacet, element: IdsCandidateElement): boolean {
  const details = element.details;
  switch (facet.kind) {
    case 'entity': {
      const entityClass = details?.type || element.ifcClass;
      if (!matchesIdsValue(facet.name, entityClass, true)) return false;
      if (facet.predefinedType) {
        const pred = getElementAttribute(element, 'PredefinedType');
        if (!matchesIdsValue(facet.predefinedType, pred, true)) return false;
      }
      return true;
    }
    case 'attribute': {
      const attrs = details?.attributes ?? {};
      const candidateNames = new Set<string>([
        ...Object.keys(attrs),
        ...(details?.name || element.name ? ['Name'] : []),
        ...(details?.globalId ? ['GlobalId'] : [])
      ]);
      for (const attrName of candidateNames) {
        if (!matchesIdsValue(facet.name, attrName, false)) continue;
        const val = getElementAttribute(element, attrName);
        if (val === null || val === '') continue;
        if (!facet.value || matchesIdsValue(facet.value, val, false)) {
          return true;
        }
      }
      return false;
    }
    case 'property': {
      const allSets: PropertySetItem[] = [
        ...(details?.propertySets ?? []),
        ...(((details as unknown as { typePropertySets?: PropertySetItem[] })?.typePropertySets) ?? [])
      ];
      for (const pset of allSets) {
        if (!matchesIdsValue(facet.propertySet, pset.name, false)) continue;
        for (const prop of pset.properties) {
          if (!matchesIdsValue(facet.baseName, prop.name, false)) continue;
          if (prop.value === null || prop.value === undefined || prop.value === '') continue;
          if (!facet.value || matchesIdsValue(facet.value, prop.value, false)) {
            return true;
          }
        }
      }
      return false;
    }
    case 'material': {
      const matNames = collectMaterialNames(details?.materials);
      if (matNames.length === 0) return false;
      if (!facet.value) return true;
      return matNames.some((m) => matchesIdsValue(facet.value!, m, false));
    }
    case 'partOf': {
      return element.ancestors.some((ancestor) =>
        matchesIdsValue(facet.entityName, ancestor, true)
      );
    }
  }
}

function checkRequirementFacet(facet: IdsFacet, element: IdsCandidateElement): string | null {
  const matched = checkFacetRawMatch(facet, element);
  const cardinality: IdsCardinality = 'cardinality' in facet ? facet.cardinality : 'required';

  if (cardinality === 'optional') {
    if (facet.kind === 'property' && facet.value) {
      const allSets: PropertySetItem[] = element.details?.propertySets ?? [];
      const hasProp = allSets.some(
        (pset) =>
          matchesIdsValue(facet.propertySet, pset.name, false) &&
          pset.properties.some(
            (p) => matchesIdsValue(facet.baseName, p.name, false) && p.value !== null
          )
      );
      if (!hasProp) return null;
      return matched
        ? null
        : t('ids.failOptionalProperty', {
            pset: describeConstraint(facet.propertySet),
            prop: describeConstraint(facet.baseName),
            value: describeConstraint(facet.value)
          });
    }
    return null;
  }

  if (cardinality === 'prohibited') {
    if (!matched) return null;
    switch (facet.kind) {
      case 'attribute':
        return t('ids.failProhibitedAttr', { name: describeConstraint(facet.name) });
      case 'property':
        return t('ids.failProhibitedProp', {
          pset: describeConstraint(facet.propertySet),
          prop: describeConstraint(facet.baseName)
        });
      case 'material':
        return facet.value
          ? t('ids.failProhibitedMaterialValue', { value: describeConstraint(facet.value) })
          : t('ids.failProhibitedMaterial');
      case 'partOf':
        return t('ids.failProhibitedPartOf', { entity: describeConstraint(facet.entityName) });
    }
  }

  if (matched) return null;

  switch (facet.kind) {
    case 'entity':
      return facet.predefinedType
        ? t('ids.failEntityWithPredefined', {
            name: describeConstraint(facet.name),
            predefined: describeConstraint(facet.predefinedType)
          })
        : t('ids.failEntity', { name: describeConstraint(facet.name) });
    case 'attribute':
      return facet.value
        ? t('ids.failAttributeWithValue', {
            name: describeConstraint(facet.name),
            value: describeConstraint(facet.value)
          })
        : t('ids.failAttribute', { name: describeConstraint(facet.name) });
    case 'property':
      return facet.value
        ? t('ids.failPropertyWithValue', {
            pset: describeConstraint(facet.propertySet),
            prop: describeConstraint(facet.baseName),
            value: describeConstraint(facet.value)
          })
        : t('ids.failProperty', {
            pset: describeConstraint(facet.propertySet),
            prop: describeConstraint(facet.baseName)
          });
    case 'material':
      return facet.value
        ? t('ids.failMaterialWithValue', { value: describeConstraint(facet.value) })
        : t('ids.failMaterial');
    case 'partOf':
      return t('ids.failPartOf', { entity: describeConstraint(facet.entityName) });
  }
}

/**
 * Evaluates all specifications of an `IdsDocument` against the candidate elements of the loaded models.
 */
export function evaluateIdsDocument(
  doc: IdsDocument,
  elements: readonly IdsCandidateElement[]
): IdsReport {
  const specifications: IdsSpecResult[] = doc.specifications.map((spec) => {
    const applicable = elements.filter((el) =>
      spec.applicability.every((facet) => checkFacetRawMatch(facet, el))
    );

    const failures: IdsElementFailure[] = [];
    let passedCount = 0;

    for (const el of applicable) {
      const reasons: string[] = [];
      for (const req of spec.requirements) {
        const failure = checkRequirementFacet(req, el);
        if (failure) reasons.push(failure);
      }
      if (reasons.length === 0) {
        passedCount++;
      } else {
        failures.push({
          modelId: el.modelId,
          modelName: el.modelName,
          expressId: el.expressId,
          ifcClass: el.details?.type || el.ifcClass,
          name: el.details?.name || el.name || `#${el.expressId}`,
          storey: el.storey,
          reasons
        });
      }
    }

    let cardinalityNote: string | undefined;
    let cardinalityFailed = false;
    if (spec.minOccurs !== undefined && applicable.length < spec.minOccurs) {
      cardinalityFailed = true;
      cardinalityNote = t('ids.minOccursNote', { min: spec.minOccurs, found: applicable.length });
    }
    if (
      spec.maxOccurs !== undefined &&
      spec.maxOccurs !== 'unbounded' &&
      applicable.length > spec.maxOccurs
    ) {
      cardinalityFailed = true;
      cardinalityNote = t('ids.maxOccursNote', { max: spec.maxOccurs, found: applicable.length });
    }

    let status: 'pass' | 'fail' | 'not-applicable';
    if (cardinalityFailed || failures.length > 0) {
      status = 'fail';
    } else if (applicable.length === 0 && spec.maxOccurs === undefined) {
      status = 'not-applicable';
    } else {
      status = 'pass';
    }

    return {
      name: spec.name,
      description: spec.description,
      instructions: spec.instructions,
      ifcVersion: spec.ifcVersion,
      status,
      applicableCount: applicable.length,
      passedCount,
      failedCount: failures.length,
      cardinalityNote,
      failures
    };
  });

  const passedSpecs = specifications.filter((s) => s.status === 'pass').length;
  const failedSpecs = specifications.filter((s) => s.status === 'fail').length;
  const notApplicableSpecs = specifications.filter((s) => s.status === 'not-applicable').length;

  return {
    title: doc.title,
    totalSpecs: specifications.length,
    passedSpecs,
    failedSpecs,
    notApplicableSpecs,
    specifications
  };
}
