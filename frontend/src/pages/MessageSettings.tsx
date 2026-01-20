import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2, Loader2, Save, X, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { templatesApi } from '../services/api';
import type { MessageTemplate } from '../types';

// Available variables for templates
const TEMPLATE_VARIABLES = [
  { name: '{customerName}', description: 'Full customer name' },
  { name: '{firstName}', description: 'First name only' },
  { name: '{category}', description: 'Service category or "your project"' },
  { name: '{city}', description: 'Customer city' },
  { name: '{state}', description: 'Customer state' },
];

export function MessageSettings() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit/create mode
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formIsDefault, setFormIsDefault] = useState(false);

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

  function startCreate() {
    setIsCreating(true);
    setEditingTemplate(null);
    setFormName('');
    setFormContent('');
    setFormIsDefault(false);
  }

  function startEdit(template: MessageTemplate) {
    setEditingTemplate(template);
    setIsCreating(false);
    setFormName(template.name);
    setFormContent(template.content);
    setFormIsDefault(template.isDefault);
  }

  function cancelEdit() {
    setEditingTemplate(null);
    setIsCreating(false);
    setFormName('');
    setFormContent('');
    setFormIsDefault(false);
  }

  async function handleSave() {
    if (!formName.trim() || !formContent.trim()) {
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (isCreating) {
        const { template } = await templatesApi.createTemplate(
          formName.trim(),
          formContent.trim(),
          formIsDefault,
        );
        setTemplates(prev => [template, ...prev]);
      } else if (editingTemplate) {
        const { template } = await templatesApi.updateTemplate(editingTemplate.id, {
          name: formName.trim(),
          content: formContent.trim(),
          isDefault: formIsDefault,
        });
        setTemplates(prev =>
          prev.map(t => (t.id === template.id ? template : t)),
        );
      }

      cancelEdit();
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

  function insertVariable(variable: string) {
    setFormContent(prev => prev + variable);
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
            {!isCreating && !editingTemplate && (
              <button className="btn btn-primary" onClick={startCreate}>
                <Plus size={16} />
                Create New
              </button>
            )}
          </div>

          {/* Create/Edit Form */}
          {(isCreating || editingTemplate) && (
            <div className="template-form">
              <div className="form-group">
                <label>Template Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g., Follow-up Message"
                  className="template-name-input"
                />
              </div>

              <div className="form-group">
                <label>Message Content</label>
                <textarea
                  value={formContent}
                  onChange={e => setFormContent(e.target.value)}
                  placeholder="Hi {firstName}, thanks for reaching out about {category}! I wanted to follow up..."
                  className="template-content-input"
                  rows={6}
                />
                <div className="variable-buttons">
                  {TEMPLATE_VARIABLES.map(v => (
                    <button
                      key={v.name}
                      type="button"
                      className="variable-btn"
                      onClick={() => insertVariable(v.name)}
                      title={v.description}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formIsDefault}
                    onChange={e => setFormIsDefault(e.target.checked)}
                  />
                  Set as default template
                </label>
              </div>

              <div className="form-actions">
                <button className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !formName.trim() || !formContent.trim()}
                >
                  {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                  {isCreating ? 'Create Template' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* Template List */}
          {templates.length === 0 && !isCreating ? (
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
                        onClick={() => startEdit(template)}
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
            {TEMPLATE_VARIABLES.map(v => (
              <div key={v.name} className="variable-item">
                <code>{v.name}</code>
                <span>{v.description}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

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
