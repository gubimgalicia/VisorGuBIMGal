import type { ElementQuery, KernelPort, SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ModelId } from '../../domain/models/ModelRecord';
import { t } from '../i18n';

export function getSearchFields(): ReadonlyArray<{ field: ElementQuery['field']; label: string }> {
  return [
    { field: 'any', label: t('search.fields.any') },
    { field: 'name', label: t('search.fields.name') },
    { field: 'class', label: t('search.fields.class') },
    { field: 'globalId', label: t('search.fields.globalId') },
    { field: 'property', label: t('search.fields.property') }
  ];
}

export interface ElementLabel {
  type: string;
  name?: string;
}

/** What the tree says of each element and spatial node, by expressId, without recursion. */
export function elementLabels(tree: SpatialTree | undefined): Map<number, ElementLabel> {
  const labels = new Map<number, ElementLabel>();
  if (!tree) return labels;
  const pending: SpatialNode[] = [tree.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    labels.set(node.expressId, { type: node.type, name: node.name });
    for (const element of node.elements) labels.set(element.expressId, { type: element.type, name: element.name });
    for (const child of node.children) pending.push(child);
  }
  for (const element of tree.unassigned) labels.set(element.expressId, { type: element.type, name: element.name });
  return labels;
}

/** The query as the display bar names it. */
export function describeQuery(query: ElementQuery): string {
  const field = getSearchFields().find((item) => item.field === query.field)?.label ?? query.field;
  const name = query.field === 'property' ? query.propertyName?.trim() : undefined;
  const text = query.text.trim();
  return t('search.describeQuery', { field, query: `${name ? `${name} = ` : ''}${text || '*'}` });
}

/** Whether the query can find anything at all, by the rules of ElementQuery. */
export function isSearchable(query: ElementQuery): boolean {
  return query.text.trim() !== '' || (query.field === 'property' && !!query.propertyName?.trim());
}

/** Every model's matches, in the order given. A model that fails is reported, not dropped. */
export async function searchModels(
  kernel: Pick<KernelPort, 'findElements'>,
  modelIds: readonly ModelId[],
  query: ElementQuery
): Promise<{ matches: Record<ModelId, number[]>; failed: ModelId[] }> {
  const matches: Record<ModelId, number[]> = {};
  const failed: ModelId[] = [];
  const found = await Promise.allSettled(modelIds.map((modelId) => kernel.findElements(modelId, query)));
  found.forEach((result, at) => {
    if (result.status === 'fulfilled') matches[modelIds[at]] = result.value;
    else failed.push(modelIds[at]);
  });
  return { matches, failed };
}
