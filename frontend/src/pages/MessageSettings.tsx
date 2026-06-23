import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Loader2, X, Info, ChevronDown, ChevronUp, FileText, Sparkles } from 'lucide-react';
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
    <div className="p-4 sm:p-6 lg:p-10 max-w-5xl mx-auto space-y-6 sm:space-y-10">
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
          <X size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Welcome Section — hero shrinks aggressively on phones so the
          Settings-page chrome above doesn't push the actual templates
          off-screen. Marketing tagline collapses, the "what is this"
          line stays as the only subtitle, and the CTA goes compact. */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 md:gap-6">
        <div className="min-w-0">
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-[10px] sm:text-xs">Messaging System</p>
          <h2 className="text-xl sm:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Message <span className="gradient-text">Templates.</span>
          </h2>
          <p className="hidden sm:block text-slate-500 mt-2 text-lg">Streamline your client communication with reusable response blocks.</p>
          <p className="text-slate-500 sm:text-slate-400 mt-2 text-sm">Used when you choose <span className="font-semibold text-slate-600">Custom Template</span> instead of AI in automation settings.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={openCreate}
            className="w-full md:w-auto px-4 sm:px-6 py-2.5 sm:py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm sm:text-base hover:bg-blue-700 shadow-md sm:shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
            Create New
          </button>
        </div>
      </section>

      {/* Templates List */}
      <section className="space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 px-1 sm:px-2">
          <h3 className="text-lg sm:text-xl font-bold text-slate-900">Your Library</h3>
          {/* Filter tabs — horizontally scrollable on mobile so the row
              stays single-line. -mx-1 + px-1 trick lets the scroll edge
              bleed to the screen edge while keeping content padding. */}
          <div className="flex items-center gap-2 flex-nowrap overflow-x-auto -mx-1 px-1 sm:flex-wrap sm:overflow-visible">
            {FILTER_TABS.map(tab => {
              const count = tab.key === 'all'
                ? templates.length
                : templates.filter(t => getTemplateFilter(t) === tab.key).length;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  className={`shrink-0 px-3 sm:px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
                    activeFilter === tab.key
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                      activeFilter === tab.key ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-500'
                    }`}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {templates.filter(t => activeFilter === 'all' || getTemplateFilter(t) === activeFilter).length === 0 ? (
          <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-12 text-center">
            <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-600 mb-2">
              {activeFilter === 'all' ? 'No templates yet' : `No ${FILTER_TABS.find(t => t.key === activeFilter)?.label} templates`}
            </h3>
            <p className="text-slate-500 mb-6 max-w-md mx-auto">
              {activeFilter === 'all'
                ? 'Templates let you send personalized follow-up messages to multiple leads at once. Create your first one to get started.'
                : 'No templates match this filter yet. Create one or check another category.'}
            </p>
            <button
              onClick={openCreate}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all inline-flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Create Template
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {templates.filter(t => activeFilter === 'all' || getTemplateFilter(t) === activeFilter).map(template => {
              const isExpanded = expandedTemplates.has(template.id);
              const isFlashing = flashId === template.id;
              const isPrompt = template.type === 'prompt';
              return (
                <div
                  key={template.id}
                  ref={(el) => { rowRefs.current[template.id] = el; }}
                  className={
                    'bg-white rounded-3xl border shadow-sm overflow-hidden transition-all ' +
                    (isFlashing
                      ? 'border-blue-500 ring-2 ring-blue-200'
                      : 'border-slate-100 hover:border-blue-200')
                  }
                  style={isFlashing ? { boxShadow: '0 0 0 4px rgba(37,99,235,0.12), 0 1px 2px rgba(10,21,48,0.04)' } : undefined}
                >
                  <div className="p-4 sm:p-6">
                    <div className="flex items-start justify-between gap-3 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 sm:gap-3 mb-2 flex-wrap">
                          <h3 className="text-base sm:text-lg font-bold text-slate-900">{template.name}</h3>
                          {isPrompt && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-50 text-violet-700 text-[10px] font-bold rounded uppercase tracking-wider">
                              <Sparkles className="w-3 h-3" /> AI Prompt
                            </span>
                          )}
                          {template.isDefault && (
                            <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-bold rounded uppercase tracking-wider">Default</span>
                          )}
                          {template.usageCount > 0 && (
                            <span className="text-xs text-slate-400">
                              • Used {template.usageCount} time{template.usageCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        <p className={`text-slate-600 text-sm leading-relaxed ${!isExpanded ? 'line-clamp-2' : ''}`}>
                          {template.content}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                        <button
                          onClick={() => toggleTemplate(template.id)}
                          className="p-1.5 sm:p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-all"
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4 sm:w-5 sm:h-5" /> : <ChevronDown className="w-4 h-4 sm:w-5 sm:h-5" />}
                        </button>
                        <button
                          onClick={() => openEdit(template)}
                          className="p-1.5 sm:p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                          title="Edit template"
                        >
                          <Pencil className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                        <button
                          onClick={() => setDeletingId(template.id)}
                          className="p-1.5 sm:p-2 text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete template"
                        >
                          <Trash2 className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && template.lastUsedAt && (
                      <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-400">
                        Last used {new Date(template.lastUsedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
