import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Loader2, X, Info, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { templatesApi } from '../services/api';
import type { MessageTemplate } from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';

// Combined variables for template page
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

type TemplateFilter = 'all' | 'auto-reply' | 'alerts' | 'call-connect';

function getTemplateFilter(name: string): TemplateFilter {
  const n = name.toLowerCase();
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
];

export function MessageSettings() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState<TemplateFilter>('all');

  // Modal state
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  async function loadTemplates() {
    try {
      setLoading(true);
      setError(null);
      const { templates } = await templatesApi.getTemplates();
      setTemplates(templates);
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
        setTemplates(prev => [template, ...prev]);
      } else if (editingTemplate) {
        const { template } = await templatesApi.updateTemplate(editingTemplate.id, {
          name,
          content,
          isDefault,
        });
        setTemplates(prev => prev.map(t => (t.id === template.id ? template : t)));
      }

      closeEditor();
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      setSaving(true);
      await templatesApi.deleteTemplate(id);
      setTemplates(prev => prev.filter(t => t.id !== id));
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
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <FileText className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Message Templates</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading templates...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
          <X size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Messaging System</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Message <span className="gradient-text">Templates.</span>
          </h2>
          <p className="text-slate-500 mt-2 text-lg">Streamline your client communication with reusable response blocks.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={openCreate}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            Create New
          </button>
        </div>
      </section>

      {/* Templates List */}
      <section className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-2">
          <h3 className="text-xl font-bold text-slate-900">Your Library</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {FILTER_TABS.map(tab => {
              const count = tab.key === 'all'
                ? templates.length
                : templates.filter(t => getTemplateFilter(t.name) === tab.key).length;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
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

        {templates.filter(t => activeFilter === 'all' || getTemplateFilter(t.name) === activeFilter).length === 0 ? (
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
            {templates.filter(t => activeFilter === 'all' || getTemplateFilter(t.name) === activeFilter).map(template => {
              const isExpanded = expandedTemplates.has(template.id);
              return (
                <div
                  key={template.id}
                  className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden hover:border-blue-200 transition-all"
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <h3 className="text-lg font-bold text-slate-900">{template.name}</h3>
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
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleTemplate(template.id)}
                          className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-all"
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </button>
                        <button
                          onClick={() => openEdit(template)}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                          title="Edit template"
                        >
                          <Pencil className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => setDeletingId(template.id)}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete template"
                        >
                          <Trash2 className="w-5 h-5" />
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
      <section className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-[2.5rem] p-8 md:p-10 text-white relative overflow-hidden">
        <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
              <Info className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Available Variables</h2>
              <p className="text-slate-400 text-sm mt-1">Use these in your templates for personalization</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ALL_VARIABLES.map(v => (
              <div key={v.name} className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-start gap-3 hover:bg-white/10 transition-colors">
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
