import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Loader2, X, Info, ChevronDown, ChevronUp, FileText, Sparkles, MessageSquare } from 'lucide-react';
import { templatesApi } from '../services/api';
import type { MessageTemplate } from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';

// Combined variables for template page
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

type TemplateFilter = 'all' | 'auto-reply' | 'alerts' | 'call-connect' | 'prompts';

function getTemplateFilter(t: MessageTemplate): TemplateFilter {
  // Prompts (type=prompt) live in their own tab regardless of name pattern.
  if (t.type === 'prompt') return 'prompts';
  const n = t.name.toLowerCase();
  if (/auto[\s-]?reply|follow[\s-]?up|welcome/.test(n)) return 'auto-reply';
  if (/alert|notification/.test(n)) return 'alerts';
  if (/^cc[\s-]|call[\s-]?connect|whisper|greeting|voicemail/.test(n)) return 'call-connect';
  return 'all';
}

const FILTER_TABS: { key: TemplateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'auto-reply', label: 'Auto Reply' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'call-connect', label: 'Call Connect' },
  { key: 'prompts', label: 'AI Prompts' },
];

// Module-level cache — survives navigation unmounts
let _templatesCache: MessageTemplate[] | null = null;

export function MessageSettings() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Capture highlight target ONCE at mount so cleaning the URL after the flash
  // doesn't cause the effect to re-evaluate to "no target" mid-animation.
  const initialHighlightRef = useRef<string | null>(searchParams.get('highlight'));
  const initialFilterRef = useRef<TemplateFilter | null>(searchParams.get('filter') as TemplateFilter | null);
  const highlightId = initialHighlightRef.current;
  const [templates, setTemplates] = useState<MessageTemplate[]>(_templatesCache ?? []);
  const [loading, setLoading] = useState(!_templatesCache);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set());
  // Pre-select the filter tab from URL (?filter=prompts etc.) so deep-links land on the right list.
  const [activeFilter, setActiveFilter] = useState<TemplateFilter>(
    initialFilterRef.current && FILTER_TABS.some(f => f.key === initialFilterRef.current) ? initialFilterRef.current : 'all',
  );
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const hasFlashedRef = useRef(false);
  // Track in-flight timeouts so unmount (e.g. user clicks Back) cancels them.
  // Otherwise the URL-cleanup setTimeout fires after the user has already left
  // /templates and rewinds them back here.
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    if (cleanupTimerRef.current) clearTimeout(cleanupTimerRef.current);
  }, []);

  // Modal state
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  // Highlight + flash + clean URL. Runs once after templates load. All
  // setTimeouts are tracked in refs and cancelled on unmount so navigating
  // away (e.g. via the top-bar Back link) doesn't get rewound by a pending
  // cleanup that calls navigate('/templates').
  useEffect(() => {
    if (!highlightId || templates.length === 0 || hasFlashedRef.current) return;
    const target = templates.find(t => t.id === highlightId);
    if (!target) return;
    // Switch to the target's tab if the active filter would hide the row.
    const targetTab = getTemplateFilter(target);
    if (activeFilter !== 'all' && activeFilter !== targetTab) {
      setActiveFilter(targetTab);
      return; // effect re-runs after activeFilter updates
    }
    // Defer one paint so the row's ref is attached.
    scrollTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      const el = rowRefs.current[highlightId];
      if (!el) return;
      hasFlashedRef.current = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(highlightId);
      // After 3s: fade the flash and strip ?highlight/?filter, but preserve
      // location.state so the top-bar back link survives.
      cleanupTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setFlashId(null);
        const sp = new URLSearchParams(searchParams);
        sp.delete('highlight');
        sp.delete('filter');
        navigate(
          { pathname: location.pathname, search: sp.toString() ? '?' + sp.toString() : '' },
          { replace: true, state: location.state },
        );
      }, 3000);
    }, 80);
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      // NOTE: cleanupTimerRef is intentionally NOT cleared here — only the
      // unmount effect clears it. We want the URL cleanup to still fire even
      // if the filter changes mid-flash.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, templates, activeFilter]);

  async function loadTemplates() {
    try {
      if (!_templatesCache) setLoading(true);
      setError(null);
      const { templates } = await templatesApi.getTemplates();
      setTemplates(templates);
      _templatesCache = templates;
    } catch (err: any) {
      setError(err.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditorMode('create');
    setEditingTemplate(null);
  }

  function openEdit(template: MessageTemplate) {
    setEditorMode('edit');
    setEditingTemplate(template);
  }

  function closeEditor() {
    setEditorMode(null);
    setEditingTemplate(null);
  }

  async function handleSave({ name, content, isDefault }: { name: string; content: string; isDefault?: boolean }) {
    try {
      setSaving(true);
      setError(null);

      if (editorMode === 'create') {
        const { template } = await templatesApi.createTemplate(name, content, isDefault);
        setTemplates(prev => { const next = [template, ...prev]; _templatesCache = next; return next; });
      } else if (editingTemplate) {
        const { template } = await templatesApi.updateTemplate(editingTemplate.id, {
          name,
          content,
          isDefault,
        });
        // If isDefault changed, re-fetch all templates so other defaults get unset in UI
        if (isDefault !== editingTemplate.isDefault) {
          const { templates: fresh } = await templatesApi.getTemplates();
          setTemplates(fresh);
          _templatesCache = fresh;
        } else {
          setTemplates(prev => { const next = prev.map(t => (t.id === template.id ? template : t)); _templatesCache = next; return next; });
        }
      }

      closeEditor();
    } catch (err: any) {
      console.error('[Templates] Save failed:', err);
      setError(err.response?.data?.message || err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      setSaving(true);
      await templatesApi.deleteTemplate(id);
      setTemplates(prev => { const next = prev.filter(t => t.id !== id); _templatesCache = next; return next; });
      setDeletingId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to delete template');
    } finally {
      setSaving(false);
    }
  }

  function toggleTemplate(id: string) {
    setExpandedTemplates(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600" />
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Message Templates</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading templates...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-5xl mx-auto space-y-6 sm:space-y-8">
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
          <X size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Templates library card — mirrors FinalDesign "Templates Screen
          (standalone)": single bordered/shadowed card with a violet
          MessageSquareText tile + "Your Library" header + Create New
          button, a horizontally-scrollable filter strip below, and flat
          template rows separated by bottom borders (no per-template
          card chrome). Drops the legacy hero ("Messaging System /
          Message Templates.") — Settings page chrome above already
          identifies the page. */}
      <section
        style={{
          background: '#fff',
          border: '1.5px solid var(--lb-line)',
          borderRadius: 14,
          boxShadow: 'var(--lb-shadow-sm)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 14,
            padding: '18px 20px',
            borderBottom: '1px solid var(--lb-line-soft)',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              width: 44, height: 44, borderRadius: 12,
              background: '#ede9fe', color: '#7c3aed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <MessageSquare className="w-5 h-5" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Your Library
            </div>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.45 }}>
              Used when you choose <strong style={{ color: 'var(--lb-ink-2)' }}>Custom Template</strong> instead of AI in your automation settings.
            </div>
          </div>
          <button
            onClick={openCreate}
            style={{
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 14px',
              borderRadius: 9, border: 0,
              background: 'var(--lb-accent)', color: '#fff',
              fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <Plus className="w-3.5 h-3.5" /> Create New
          </button>
        </div>

        {/* Filter strip — horizontally scrollable so the row stays
            single-line on phones with negative-margin scroll bleed. */}
        <div style={{ padding: '14px 20px 6px' }}>
          <div
            style={{
              display: 'flex', gap: 8,
              overflowX: 'auto',
              WebkitOverflowScrolling: 'touch',
              paddingBottom: 4,
              marginLeft: -4, paddingLeft: 4,
              marginRight: -4, paddingRight: 4,
            }}
          >
            {FILTER_TABS.map(tab => {
              const count = tab.key === 'all'
                ? templates.length
                : templates.filter(t => getTemplateFilter(t) === tab.key).length;
              const active = activeFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '7px 12px',
                    borderRadius: 999,
                    border: '1px solid ' + (active ? 'var(--lb-accent)' : 'var(--lb-line)'),
                    background: active ? 'var(--lb-accent)' : 'var(--lb-surface)',
                    color: active ? '#fff' : 'var(--lb-ink-3)',
                    fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tab.label}
                  {count > 0 && (
                    <span
                      style={{
                        fontSize: 10, fontWeight: 700,
                        padding: '1px 7px', borderRadius: 999,
                        background: active ? 'rgba(255,255,255,0.22)' : 'var(--lb-ink-10)',
                        color: active ? '#fff' : 'var(--lb-ink-5)',
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Templates list — flat rows separated by bottom borders. */}
        <div style={{ padding: '6px 20px 8px' }}>
          {templates.filter(t => activeFilter === 'all' || getTemplateFilter(t) === activeFilter).length === 0 ? (
            <div
              style={{
                margin: '12px 0 16px',
                padding: 28,
                textAlign: 'center',
                border: '1px dashed var(--lb-line)',
                borderRadius: 12,
                background: 'var(--lb-bg, #f8fafc)',
              }}
            >
              <FileText className="w-10 h-10" style={{ color: 'var(--lb-ink-6)', margin: '0 auto 10px' }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-2)', marginBottom: 4 }}>
                {activeFilter === 'all' ? 'No templates yet' : `No ${FILTER_TABS.find(t => t.key === activeFilter)?.label} templates`}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5, maxWidth: 320, margin: '0 auto 14px' }}>
                {activeFilter === 'all'
                  ? 'Templates let you send personalized follow-up messages to multiple leads at once. Create your first one to get started.'
                  : 'No templates match this filter yet. Create one or check another category.'}
              </div>
              <button
                onClick={openCreate}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px',
                  borderRadius: 9, border: 0,
                  background: 'var(--lb-accent)', color: '#fff',
                  fontSize: 12.5, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Plus className="w-3.5 h-3.5" /> Create Template
              </button>
            </div>
          ) : (
            templates.filter(t => activeFilter === 'all' || getTemplateFilter(t) === activeFilter).map((template, idx, arr) => {
              const isExpanded = expandedTemplates.has(template.id);
              const isFlashing = flashId === template.id;
              const isPrompt = template.type === 'prompt';
              const isLast = idx === arr.length - 1;
              return (
                <div
                  key={template.id}
                  ref={(el) => { rowRefs.current[template.id] = el; }}
                  style={{
                    padding: '16px 0',
                    borderBottom: isLast ? 'none' : '1px solid var(--lb-line-soft)',
                    ...(isFlashing
                      ? { boxShadow: '0 0 0 3px rgba(37,99,235,0.14)', borderRadius: 10, padding: '16px 12px' }
                      : {}),
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        flex: 1, minWidth: 0,
                        fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {template.name}
                    </span>
                    <button
                      onClick={() => toggleTemplate(template.id)}
                      aria-label={isExpanded ? 'Collapse' : 'Expand'}
                      style={{
                        width: 32, height: 32, borderRadius: 8,
                        border: '1px solid var(--lb-line)', background: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', flexShrink: 0, color: 'var(--lb-ink-4)',
                      }}
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => openEdit(template)}
                      aria-label="Edit"
                      style={{
                        width: 32, height: 32, borderRadius: 8,
                        border: '1px solid var(--lb-line)', background: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', flexShrink: 0, color: 'var(--lb-accent)',
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeletingId(template.id)}
                      aria-label="Delete"
                      style={{
                        width: 32, height: 32, borderRadius: 8,
                        border: '1px solid var(--lb-line)', background: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', flexShrink: 0, color: 'var(--lb-danger)',
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 9 }}>
                    {isPrompt && (
                      <span
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 4,
                          background: '#f5f3ff', color: '#7c3aed',
                          fontSize: 10, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}
                      >
                        <Sparkles className="w-2.5 h-2.5" /> AI Prompt
                      </span>
                    )}
                    {template.isDefault && (
                      <span
                        style={{
                          padding: '2px 8px', borderRadius: 4,
                          background: '#eff6ff', color: '#2563eb',
                          fontSize: 10, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}
                      >
                        Default
                      </span>
                    )}
                    {template.usageCount > 0 && (
                      <span style={{ fontSize: 11.5, color: 'var(--lb-ink-6)', fontFamily: 'var(--lb-font-mono)' }}>
                        Used {template.usageCount} time{template.usageCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <p
                    style={{
                      margin: '11px 0 0',
                      fontSize: 13, color: 'var(--lb-ink-4)', lineHeight: 1.55,
                      ...(isExpanded ? {} : {
                        display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }),
                    } as React.CSSProperties}
                  >
                    {template.content}
                  </p>
                  {isExpanded && template.lastUsedAt && (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--lb-ink-6)' }}>
                      Last used {new Date(template.lastUsedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Variables Reference */}
      <section className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl sm:rounded-[2.5rem] p-5 sm:p-8 md:p-10 text-white relative overflow-hidden">
        <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4 sm:mb-6">
            <div className="w-10 h-10 sm:w-12 sm:h-12 bg-white/10 rounded-xl flex items-center justify-center shrink-0">
              <Info className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-bold">Available Variables</h2>
              <p className="text-slate-400 text-xs sm:text-sm mt-0.5 sm:mt-1">Use these in your templates for personalization</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ALL_VARIABLES.map(v => (
              <div key={v.name} className="bg-white/5 border border-white/10 rounded-xl p-3 sm:p-4 flex items-start gap-3 hover:bg-white/10 transition-colors">
                <code className="bg-white/10 px-2 py-1 rounded text-blue-300 text-xs font-mono shrink-0">{v.name}</code>
                <span className="text-slate-300 text-sm">{v.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Template Editor Modal */}
      <TemplateEditorModal
        isOpen={!!editorMode}
        onClose={closeEditor}
        mode={editorMode || 'create'}
        initialName={editingTemplate?.name || ''}
        initialContent={editingTemplate?.content || ''}
        saving={saving}
        variables={ALL_VARIABLES}
        existingNames={templates.filter(t => t.id !== editingTemplate?.id).map(t => t.name)}
        showDefaultCheckbox={true}
        initialIsDefault={editingTemplate?.isDefault || false}
        saveError={error}
        onSave={handleSave}
      />

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setDeletingId(null)}>
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-2xl font-bold text-slate-900 mb-2">Delete Template?</h3>
            <p className="text-slate-500 mb-8">Are you sure you want to delete this template? This action cannot be undone.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeletingId(null)}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deletingId)}
                disabled={saving}
                className="flex-1 px-6 py-3 bg-red-600 text-white rounded-xl font-semibold hover:bg-red-700 shadow-lg shadow-red-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
