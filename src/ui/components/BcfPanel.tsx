import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Download,
  Eye,
  MessageSquare,
  Plus,
  Trash2,
  Upload
} from 'lucide-react';
import {
  emptyExtensions,
  newGuid,
  readBcf,
  writeBcf,
  type BcfComment,
  type BcfProject,
  type BcfTopic,
  type BcfViewpoint
} from '../viewer/bcf';
import { filePort } from '../../infrastructure/composition';
import { t } from '../i18n';

const DEFAULT_TYPES = ['Issue', 'Clash', 'Request', 'Remark'];
const DEFAULT_STATUSES = ['Open', 'InProgress', 'Resolved', 'Closed'];
const DEFAULT_PRIORITIES = ['High', 'Normal', 'Low'];

const STATUS_KEYS: Record<string, 'bcf.statusOpen' | 'bcf.statusInProgress' | 'bcf.statusResolved' | 'bcf.statusClosed'> = {
  Open: 'bcf.statusOpen',
  InProgress: 'bcf.statusInProgress',
  Resolved: 'bcf.statusResolved',
  Closed: 'bcf.statusClosed'
};

const PRIORITY_KEYS: Record<string, 'bcf.priorityHigh' | 'bcf.priorityNormal' | 'bcf.priorityLow'> = {
  High: 'bcf.priorityHigh',
  Normal: 'bcf.priorityNormal',
  Low: 'bcf.priorityLow'
};

const getStatusLabel = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
};

const getPriorityLabel = (priority: string): string => {
  const key = PRIORITY_KEYS[priority];
  return key ? t(key) : priority;
};

function createInitialProject(): BcfProject {
  return {
    version: '3.0',
    project: { projectId: newGuid(), name: t('bcf.defaultProjectName') },
    extensions: {
      ...emptyExtensions(),
      topicTypes: [...DEFAULT_TYPES],
      topicStatuses: [...DEFAULT_STATUSES],
      priorities: [...DEFAULT_PRIORITIES],
      users: ['guBIM']
    },
    topics: [],
    otherFiles: new Map()
  };
}

function snapshotToDataUrl(snapshot: { bytes: Uint8Array; format: 'png' | 'jpg' }): string {
  let binary = '';
  const bytes = snapshot.bytes;
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const mime = snapshot.format === 'jpg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${btoa(binary)}`;
}

export interface BcfPanelProps {
  onCaptureViewpoint: (index: number) => Promise<BcfViewpoint | null>;
  onApplyViewpoint: (viewpoint: BcfViewpoint) => Promise<void>;
  pendingTopic?: { seq: number; topic: BcfTopic } | null;
}

export const BcfPanel: React.FC<BcfPanelProps> = ({
  onCaptureViewpoint,
  onApplyViewpoint,
  pendingTopic
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPendingSeqRef = useRef<number>(0);
  const [project, setProject] = useState<BcfProject>(() => createInitialProject());
  const [activeTopicGuid, setActiveTopicGuid] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  // New topic form state
  const [newTitle, setNewTitle] = useState<string>('');
  const [newType, setNewType] = useState<string>('Issue');
  const [newStatus, setNewStatus] = useState<string>('Open');
  const [newPriority, setNewPriority] = useState<string>('Normal');
  const [newAuthor, setNewAuthor] = useState<string>('guBIM');
  const [newDescription, setNewDescription] = useState<string>('');

  // New comment form state
  const [commentText, setCommentText] = useState<string>('');
  const [commentViewpointGuid, setCommentViewpointGuid] = useState<string>('');

  const activeTopic = useMemo(
    () => project.topics.find((t) => t.guid === activeTopicGuid) ?? project.topics[0] ?? null,
    [project.topics, activeTopicGuid]
  );

  useEffect(() => {
    if (activeTopic && activeTopic.guid !== activeTopicGuid) {
      setActiveTopicGuid(activeTopic.guid);
    } else if (!activeTopic && activeTopicGuid !== null) {
      setActiveTopicGuid(null);
    }
  }, [activeTopic, activeTopicGuid]);

  useEffect(() => {
    if (!pendingTopic || pendingTopic.seq === lastPendingSeqRef.current) return;
    lastPendingSeqRef.current = pendingTopic.seq;
    const incoming = pendingTopic.topic;
    setProject((prev) => ({
      ...prev,
      extensions: {
        ...prev.extensions,
        topicTypes: prev.extensions.topicTypes.includes(incoming.topicType)
          ? prev.extensions.topicTypes
          : [...prev.extensions.topicTypes, incoming.topicType]
      },
      topics: [
        ...prev.topics,
        { ...incoming, index: incoming.index ?? prev.topics.length + 1 }
      ]
    }));
    setActiveTopicGuid(incoming.guid);
    setErrorText(null);
  }, [pendingTopic]);

  const topicTypes = useMemo(
    () => [...new Set([...DEFAULT_TYPES, ...project.extensions.topicTypes])],
    [project.extensions.topicTypes]
  );
  const topicStatuses = useMemo(
    () => [...new Set([...DEFAULT_STATUSES, ...project.extensions.topicStatuses])],
    [project.extensions.topicStatuses]
  );
  const priorities = useMemo(
    () => [...new Set([...DEFAULT_PRIORITIES, ...project.extensions.priorities])],
    [project.extensions.priorities]
  );

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsBusy(true);
    setErrorText(null);
    try {
      const buffer = await file.arrayBuffer();
      const imported = await readBcf(new Uint8Array(buffer));
      setProject(imported);
      setActiveTopicGuid(imported.topics[0]?.guid ?? null);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : t('bcf.readError'));
    } finally {
      setIsBusy(false);
    }
  }, []);

  const handleExportBcf = useCallback(async () => {
    if (project.topics.length === 0) return;
    setIsBusy(true);
    setErrorText(null);
    try {
      const bytes = await writeBcf(project);
      const filename = t('bcf.exportFilename');
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__gubim_last_bcf__ = {
          filename,
          bytes,
          topicCount: project.topics.length
        };
      }
      await filePort.saveFile({
        defaultName: filename,
        content: bytes,
        mimeType: 'application/octet-stream',
        filterName: 'BCF 3.0',
        extensions: ['bcf']
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : t('bcf.exportError'));
    } finally {
      setIsBusy(false);
    }
  }, [project]);

  const handleAddTopic = useCallback(() => {
    const trimmedTitle =
      newTitle.trim() || t('bcf.defaultTopicTitle', { index: project.topics.length + 1 });
    const trimmedAuthor = newAuthor.trim() || 'guBIM';
    const trimmedDesc = newDescription.trim();
    const nowIso = new Date().toISOString();
    const guid = newGuid();

    const topic: BcfTopic = {
      guid,
      topicType: newType,
      topicStatus: newStatus,
      referenceLinks: [],
      title: trimmedTitle,
      priority: newPriority,
      index: project.topics.length + 1,
      labels: [],
      creationDate: nowIso,
      creationAuthor: trimmedAuthor,
      description: trimmedDesc.length > 0 ? trimmedDesc : undefined,
      documentReferences: [],
      relatedTopics: [],
      comments: [],
      viewpoints: [],
      files: []
    };

    setProject((prev) => ({
      ...prev,
      topics: [...prev.topics, topic]
    }));
    setActiveTopicGuid(guid);
    setNewTitle('');
    setNewDescription('');
    setErrorText(null);
  }, [newTitle, newAuthor, newDescription, newType, newStatus, newPriority, project.topics.length]);

  const handleUpdateTopicStatus = useCallback((guid: string, nextStatus: string) => {
    const nowIso = new Date().toISOString();
    setProject((prev) => ({
      ...prev,
      topics: prev.topics.map((t) =>
        t.guid === guid ? { ...t, topicStatus: nextStatus, modifiedDate: nowIso } : t
      )
    }));
  }, []);

  const handleDeleteTopic = useCallback((guid: string) => {
    setProject((prev) => ({
      ...prev,
      topics: prev.topics.filter((t) => t.guid !== guid)
    }));
  }, []);

  const handleCaptureViewpoint = useCallback(async () => {
    if (!activeTopic) return;
    setIsBusy(true);
    setErrorText(null);
    try {
      const nextIndex = activeTopic.viewpoints.length + 1;
      const vp = await onCaptureViewpoint(nextIndex);
      if (!vp) return;
      setProject((prev) => ({
        ...prev,
        topics: prev.topics.map((t) =>
          t.guid === activeTopic.guid ? { ...t, viewpoints: [...t.viewpoints, vp] } : t
        )
      }));
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : t('bcf.captureViewpointError'));
    } finally {
      setIsBusy(false);
    }
  }, [activeTopic, onCaptureViewpoint]);

  const handleDeleteViewpoint = useCallback((topicGuid: string, vpGuid: string) => {
    setProject((prev) => ({
      ...prev,
      topics: prev.topics.map((t) =>
        t.guid === topicGuid
          ? {
              ...t,
              viewpoints: t.viewpoints.filter((v) => v.guid !== vpGuid),
              comments: t.comments.map((c) =>
                c.viewpointGuid === vpGuid ? { ...c, viewpointGuid: undefined } : c
              )
            }
          : t
      )
    }));
    setCommentViewpointGuid((prev) => (prev === vpGuid ? '' : prev));
  }, []);

  const handleAddComment = useCallback(() => {
    if (!activeTopic) return;
    const text = commentText.trim();
    if (!text) return;
    const author = newAuthor.trim() || 'guBIM';
    const newComment: BcfComment = {
      guid: newGuid(),
      date: new Date().toISOString(),
      author,
      comment: text,
      viewpointGuid: commentViewpointGuid || undefined
    };
    setProject((prev) => ({
      ...prev,
      topics: prev.topics.map((t) =>
        t.guid === activeTopic.guid ? { ...t, comments: [...t.comments, newComment] } : t
      )
    }));
    setCommentText('');
  }, [activeTopic, commentText, newAuthor, commentViewpointGuid]);

  return (
    <div className="bcf-panel" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <input
        ref={fileInputRef}
        className="bcf-file-input"
        type="file"
        accept=".bcf,.bcfzip,.zip"
        style={{ display: 'none' }}
        onChange={(e) => void handleImportFile(e)}
      />

      {/* Import / Export toolbar */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm bcf-import-btn"
          style={{ flex: 1 }}
          disabled={isBusy}
          onClick={() => fileInputRef.current?.click()}
          title={t('bcf.importTitle')}
        >
          <Upload size={13} />
          <span>{t('bcf.importLabel')}</span>
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm bcf-export-btn"
          style={{ flex: 1 }}
          disabled={isBusy || project.topics.length === 0}
          onClick={() => void handleExportBcf()}
          title={t('bcf.exportTitle')}
        >
          <Download size={13} />
          <span>{t('bcf.exportLabel')}</span>
        </button>
      </div>

      {errorText && (
        <div
          className="bcf-error"
          style={{
            padding: '8px',
            borderRadius: '6px',
            backgroundColor: 'rgba(248, 113, 113, 0.12)',
            color: '#f87171',
            fontSize: '11px'
          }}
        >
          {errorText}
        </div>
      )}

      {/* New topic form */}
      <div
        className="bcf-new-topic-box"
        style={{
          padding: '8px 10px',
          borderRadius: '6px',
          backgroundColor: 'rgba(30, 41, 59, 0.65)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px'
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 600, color: '#cbd5e1' }}>
          {t('bcf.newTopicHeading')}
        </div>
        <input
          type="text"
          className="bcf-new-topic-title"
          placeholder={t('bcf.titlePlaceholder')}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddTopic();
          }}
          style={{
            width: '100%',
            padding: '5px 8px',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid rgba(255,255,255,0.12)',
            backgroundColor: 'rgba(15, 23, 42, 0.8)',
            color: '#f8fafc'
          }}
        />
        <div style={{ display: 'flex', gap: '4px' }}>
          <select
            className="bcf-new-topic-type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            aria-label={t('bcf.typeAriaLabel')}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0'
            }}
          >
            {topicTypes.map((topicType) => (
              <option key={topicType} value={topicType}>
                {topicType}
              </option>
            ))}
          </select>
          <select
            className="bcf-new-topic-status"
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value)}
            aria-label={t('bcf.statusAriaLabel')}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0'
            }}
          >
            {topicStatuses.map((s) => (
              <option key={s} value={s}>
                {getStatusLabel(s)}
              </option>
            ))}
          </select>
          <select
            className="bcf-new-topic-priority"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value)}
            aria-label={t('bcf.priorityAriaLabel')}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0'
            }}
          >
            {priorities.map((p) => (
              <option key={p} value={p}>
                {getPriorityLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <input
            type="text"
            className="bcf-new-topic-author"
            placeholder={t('bcf.authorPlaceholder')}
            value={newAuthor}
            onChange={(e) => setNewAuthor(e.target.value)}
            style={{
              width: '90px',
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0'
            }}
          />
          <input
            type="text"
            className="bcf-new-topic-desc"
            placeholder={t('bcf.descriptionPlaceholder')}
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0'
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm bcf-add-topic-btn"
          disabled={isBusy}
          onClick={handleAddTopic}
        >
          <Plus size={13} />
          <span>{t('bcf.createTopicBtn')}</span>
        </button>
      </div>

      {/* Topic list */}
      {project.topics.length === 0 ? (
        <div style={{ padding: '16px 10px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
          {t('bcf.emptyBeforeExt')}
          <strong>{t('bcf.emptyExt')}</strong>
          {t('bcf.emptyAfterExt')}
        </div>
      ) : (
        <div className="bcf-topic-list" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
            {t('bcf.topicsHeading', { count: project.topics.length, version: project.version })}
          </div>
          {project.topics.map((topic) => {
            const isSelected = activeTopic?.guid === topic.guid;
            return (
              <div
                key={topic.guid}
                className={`bcf-topic-card ${isSelected ? 'active' : ''}`}
                data-guid={topic.guid}
                onClick={() => setActiveTopicGuid(topic.guid)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  backgroundColor: isSelected ? 'rgba(30, 58, 138, 0.35)' : 'rgba(15, 23, 42, 0.65)',
                  border: `1px solid ${
                    isSelected ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.08)'
                  }`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                  <span
                    className="bcf-topic-title"
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#f8fafc',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {topic.title || t('bcf.untitledTopic')}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span
                      className="bcf-topic-status-badge"
                      style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(56, 189, 248, 0.15)',
                        color: '#38bdf8'
                      }}
                    >
                      {getStatusLabel(topic.topicStatus || DEFAULT_STATUSES[0])}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon bcf-delete-topic-btn"
                      style={{ width: '20px', height: '20px', padding: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTopic(topic.guid);
                      }}
                      title={t('bcf.deleteTopicTitle')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px', fontSize: '10px', color: '#94a3b8' }}>
                  <span>{topic.topicType || DEFAULT_TYPES[0]}</span>
                  {topic.priority && <span>{t('bcf.priorityLine', { priority: getPriorityLabel(topic.priority) })}</span>}
                  <span>{t('bcf.viewsLine', { count: topic.viewpoints.length })}</span>
                  <span>{t('bcf.commentsLine', { count: topic.comments.length })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active topic detail: status, description, viewpoints, comments */}
      {activeTopic && (
        <div
          className="bcf-topic-detail"
          style={{
            padding: '10px',
            borderRadius: '6px',
            backgroundColor: 'rgba(15, 23, 42, 0.8)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>
              {activeTopic.title}
            </div>
            <select
              className="bcf-topic-status-select"
              value={activeTopic.topicStatus || 'Open'}
              onChange={(e) => handleUpdateTopicStatus(activeTopic.guid, e.target.value)}
              style={{
                padding: '3px 6px',
                fontSize: '11px',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.15)',
                backgroundColor: 'rgba(30, 41, 59, 0.9)',
                color: '#f8fafc'
              }}
            >
              {topicStatuses.map((s) => (
                <option key={s} value={s}>
                  {getStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>

          {activeTopic.description && (
            <div className="bcf-topic-description" style={{ fontSize: '11px', color: '#cbd5e1' }}>
              {activeTopic.description}
            </div>
          )}

          {/* Viewpoints section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8' }}>
                {t('bcf.viewpointsHeading', { count: activeTopic.viewpoints.length })}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm bcf-capture-viewpoint-btn"
                disabled={isBusy}
                onClick={() => void handleCaptureViewpoint()}
                title={t('bcf.captureViewpointTitle')}
              >
                <Camera size={12} />
                <span>{t('bcf.captureViewpointBtn')}</span>
              </button>
            </div>

            {activeTopic.viewpoints.map((vp, idx) => {
              const thumbUrl = vp.snapshot ? snapshotToDataUrl(vp.snapshot) : null;
              return (
                <div
                  key={vp.guid}
                  className="bcf-viewpoint-card"
                  data-guid={vp.guid}
                  style={{
                    padding: '6px 8px',
                    borderRadius: '6px',
                    backgroundColor: 'rgba(30, 41, 59, 0.7)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'center'
                  }}
                >
                  {thumbUrl && (
                    <img
                      src={thumbUrl}
                      alt={t('bcf.viewpointAlt', { index: idx + 1 })}
                      className="bcf-viewpoint-thumb"
                      onClick={() => void onApplyViewpoint(vp)}
                      style={{
                        width: '64px',
                        height: '42px',
                        objectFit: 'cover',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        border: '1px solid rgba(255,255,255,0.12)'
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#e2e8f0' }}>
                      {t('bcf.viewpointHeader', { index: vp.index ?? idx + 1 })}
                      <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: '10px' }}>
                        {t('bcf.viewpointKindParen', {
                          kind: vp.camera?.kind === 'orthogonal' ? t('common.orthoShort') : t('common.perspShort')
                        })}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                      {vp.selection.length > 0 && (
                        <span className="bcf-vp-sel-count">{t('bcf.vpSelCount', { count: vp.selection.length })}</span>
                      )}
                      {vp.visibility && vp.visibility.exceptions.length > 0 && (
                        <span className="bcf-vp-vis-count">
                          {t('bcf.vpVisCount', {
                            label: vp.visibility.defaultVisibility
                              ? t('bcf.vpHiddenLabel')
                              : t('bcf.vpIsolatedLabel'),
                            count: vp.visibility.exceptions.length
                          })}
                        </span>
                      )}
                      {vp.coloring.length > 0 && (
                        <span className="bcf-vp-color-count">{t('bcf.vpColorCount', { count: vp.coloring.length })}</span>
                      )}
                      {vp.clippingPlanes.length > 0 && (
                        <span className="bcf-vp-planes-count">{t('bcf.vpPlanesCount', { count: vp.clippingPlanes.length })}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm bcf-apply-viewpoint-btn"
                      style={{ padding: '3px 6px', fontSize: '10px' }}
                      onClick={() => void onApplyViewpoint(vp)}
                      title={t('bcf.applyViewpointTitle')}
                    >
                      <Eye size={12} />
                      <span>{t('bcf.applyViewpointBtn')}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon bcf-delete-viewpoint-btn"
                      style={{ width: '22px', height: '22px', padding: 0 }}
                      onClick={() => handleDeleteViewpoint(activeTopic.guid, vp.guid)}
                      title={t('bcf.deleteViewpointTitle')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Comments section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MessageSquare size={12} />
              <span>{t('bcf.commentsHeading', { count: activeTopic.comments.length })}</span>
            </div>

            {activeTopic.comments.map((c) => {
              const linkedVp = c.viewpointGuid
                ? activeTopic.viewpoints.find((v) => v.guid === c.viewpointGuid)
                : undefined;
              return (
                <div
                  key={c.guid}
                  className="bcf-comment-item"
                  style={{
                    padding: '6px 8px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(30, 41, 59, 0.55)',
                    fontSize: '11px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '10px' }}>
                    <strong>{c.author || t('bcf.anonymousAuthor')}</strong>
                    <span>{c.date ? c.date.slice(0, 10) : ''}</span>
                  </div>
                  <div className="bcf-comment-text" style={{ color: '#e2e8f0', marginTop: '2px' }}>
                    {c.comment}
                  </div>
                  {linkedVp && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm bcf-comment-viewpoint-btn"
                      style={{ marginTop: '4px', padding: '1px 5px', fontSize: '10px', color: '#38bdf8' }}
                      onClick={() => void onApplyViewpoint(linkedVp)}
                    >
                      <Eye size={10} />
                      <span>{t('bcf.goToLinkedViewpoint')}</span>
                    </button>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
              <input
                type="text"
                className="bcf-comment-input"
                placeholder={t('bcf.commentPlaceholder')}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddComment();
                }}
                style={{
                  flex: 1,
                  padding: '4px 6px',
                  fontSize: '11px',
                  borderRadius: '4px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  backgroundColor: 'rgba(15, 23, 42, 0.9)',
                  color: '#f8fafc'
                }}
              />
              {activeTopic.viewpoints.length > 0 && (
                <select
                  className="bcf-comment-viewpoint-select"
                  value={commentViewpointGuid}
                  onChange={(e) => setCommentViewpointGuid(e.target.value)}
                  aria-label={t('bcf.linkViewpointAriaLabel')}
                  style={{
                    width: '82px',
                    padding: '4px',
                    fontSize: '10px',
                    borderRadius: '4px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    color: '#cbd5e1'
                  }}
                >
                  <option value="">{t('bcf.noLinkedViewpoint')}</option>
                  {activeTopic.viewpoints.map((vp, idx) => (
                    <option key={vp.guid} value={vp.guid}>
                      {t('bcf.viewpointOption', { index: vp.index ?? idx + 1 })}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm bcf-add-comment-btn"
                onClick={handleAddComment}
              >
                {t('common.add')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
