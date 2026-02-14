import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2, Loader2, X, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { templatesApi } from '../services/api';
import type { MessageTemplate } from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';

// Combined variables for template page
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

export function MessageSettings() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="message-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>Message Templates</h1>
        </div>
        <div className="loading-container">
          <Loader2 size={32} className="spinner" />
          <p>Loading templates...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-settings">
      <div className="settings-header">
        <button className="btn-icon" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
        </button>
        <h1>Message Templates</h1>
      </div>

      {error && (
        <div className="error-message">
          <X size={16} />
          {error}
          <button className="btn-icon" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <div className="settings-content">
        {/* Template List */}
        <div className="templates-section">
          <div className="section-header">
            <h2>Your Templates</h2>
            <button className="btn btn-primary" onClick={openCreate}>
              <Plus size={16} />
              Create New
            </button>
          </div>

          {templates.length === 0 ? (
            <div className="empty-templates">
              <p>You haven't created any templates yet.</p>
              <p className="hint">
                Templates let you send personalized follow-up messages to multiple leads at once.
              </p>
            </div>
          ) : (
            <div className="templates-list">
              {templates.map(template => (
                <div
                  key={template.id}
                  className={`template-card ${template.isDefault ? 'default' : ''}`}
                >
                  <div className="template-header">
                    <h3>
                      {template.name}
                      {template.isDefault && <span className="default-badge">Default</span>}
                    </h3>
                    <div className="template-actions">
                      <button
                        className="btn-icon"
                        onClick={() => openEdit(template)}
                        title="Edit template"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="btn-icon btn-danger-subtle"
                        onClick={() => setDeletingId(template.id)}
                        title="Delete template"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  <p className="template-preview">{template.content}</p>
                  {template.usageCount > 0 && (
                    <div className="template-stats">
                      Used {template.usageCount} time{template.usageCount !== 1 ? 's' : ''}
                      {template.lastUsedAt && (
                        <> - Last used {new Date(template.lastUsedAt).toLocaleDateString()}</>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Variables Reference */}
        <div className="variables-section">
          <h2>
            <Info size={18} />
            Available Variables
          </h2>
          <p className="section-description">
            Use these variables in your templates. They'll be replaced with actual customer data when sending.
          </p>
          <div className="variables-list">
            {ALL_VARIABLES.map(v => (
              <div key={v.name} className="variable-item">
                <code>{v.name}</code>
                <span>{v.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

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
        <div className="modal-overlay" onClick={() => setDeletingId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Delete Template?</h3>
            <p>Are you sure you want to delete this template? This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeletingId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDelete(deletingId)}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spinner" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
