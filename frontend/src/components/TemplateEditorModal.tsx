import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';

export interface TemplateVariable {
  name: string;
  desc: string;
}

// Variable sets for different template contexts
export const AUTO_REPLY_VARIABLES: TemplateVariable[] = [
  { name: '{customerName}', desc: 'Full customer name' },
  { name: '{firstName}', desc: 'First name only' },
  { name: '{category}', desc: 'Service category' },
  { name: '{city}', desc: 'Customer city' },
  { name: '{state}', desc: 'Customer state' },
];

export const SMS_VARIABLES: TemplateVariable[] = [
  { name: '{{lead.name}}', desc: 'Customer name' },
  { name: '{{lead.phone}}', desc: 'Customer phone' },
  { name: '{{lead.service}}', desc: 'Service category' },
  { name: '{{lead.location}}', desc: 'City, State' },
  { name: '{{lead.zip}}', desc: 'ZIP code' },
  { name: '{{lead.message}}', desc: 'Customer request message' },
  { name: '{{lead.serviceDescription}}', desc: 'Detailed service description' },
  { name: '{{lead.addons}}', desc: 'Service add-ons' },
  { name: '{{lead.frequency}}', desc: 'Service frequency' },
  { name: '{{lead.bedrooms}}', desc: 'Number of bedrooms' },
  { name: '{{lead.bathrooms}}', desc: 'Number of bathrooms' },
  { name: '{{lead.price}}', desc: 'Lead price/cost' },
  { name: '{{lead.pets}}', desc: 'Pet information' },
  { name: '{{lead.estimate}}', desc: 'Estimated cost/quote' },
  { name: '{{lead.dates}}', desc: 'Requested date/schedule' },
];

interface TemplateEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'create' | 'edit' | 'service-edit';
  initialName: string;
  initialContent: string;
  templateName?: string;
  saving: boolean;
  variables: TemplateVariable[];
  existingNames?: string[];
  showDefaultCheckbox?: boolean;
  initialIsDefault?: boolean;
  onSave: (data: { name: string; content: string; isDefault?: boolean }) => void;
  onSaveAsNew?: (data: { name: string; content: string }) => void;
}

export function TemplateEditorModal({
  isOpen, onClose, mode, initialName, initialContent,
  templateName, saving, variables, existingNames = [],
  showDefaultCheckbox, initialIsDefault,
  onSave, onSaveAsNew,
}: TemplateEditorModalProps) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [isDefault, setIsDefault] = useState(initialIsDefault || false);
  const [saveAsNewMode, setSaveAsNewMode] = useState(false);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setContent(initialContent);
      setIsDefault(initialIsDefault || false);
      setSaveAsNewMode(false);
      setNewName('');
      setNameError(null);
    }
  }, [isOpen, initialName, initialContent, initialIsDefault]);

  if (!isOpen) return null;

  function insertVariable(variable: string) {
    const textarea = contentRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = content.substring(0, start) + variable + content.substring(end);
      setContent(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + variable.length;
        textarea.focus();
      }, 0);
    } else {
      setContent(prev => prev + variable);
    }
  }

  function validateName(checkName: string): boolean {
    const trimmed = checkName.trim();
    if (!trimmed) {
      setNameError('Template name is required');
      return false;
    }
    if (existingNames.some(n => n.toLowerCase() === trimmed.toLowerCase())) {
      setNameError('A template with this name already exists');
      return false;
    }
    return true;
  }

  function handleSave() {
    if (mode === 'create' || mode === 'edit') {
      if (!validateName(name)) return;
    }
    onSave({ name: name.trim(), content: content.trim(), isDefault });
  }

  function handleSaveAsNew() {
    if (!validateName(newName)) return;
    onSaveAsNew?.({ name: newName.trim(), content: content.trim() });
  }

  const title = mode === 'create' ? 'Create Template' : 'Edit Template';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="template-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="template-editor-header">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="template-editor-body">
          {(mode === 'create' || mode === 'edit') && (
            <div className="form-group">
              <label>Template Name</label>
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setNameError(null); }}
                placeholder="e.g., Follow-up Message"
              />
              {nameError && !saveAsNewMode && <span className="field-error">{nameError}</span>}
            </div>
          )}

          {mode === 'service-edit' && !saveAsNewMode && (
            <div className="template-editor-name-display">
              Editing: <strong>{templateName || name}</strong>
            </div>
          )}

          {mode === 'service-edit' && saveAsNewMode && (
            <div className="form-group">
              <label>New Template Name</label>
              <input
                type="text"
                value={newName}
                onChange={e => { setNewName(e.target.value); setNameError(null); }}
                placeholder="Enter template name"
                autoFocus
              />
              {nameError && <span className="field-error">{nameError}</span>}
            </div>
          )}

          <div className="form-group">
            <label>Content</label>
            <textarea
              ref={contentRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Enter template content..."
              rows={8}
              className="template-editor-textarea"
            />
          </div>

          {variables.length > 0 && (
            <div className="template-editor-variables">
              <label>Variables <span className="form-hint">(click to insert at cursor)</span></label>
              <div className="variable-buttons">
                {variables.map(v => (
                  <button
                    key={v.name}
                    type="button"
                    className="variable-btn"
                    onClick={() => insertVariable(v.name)}
                    title={v.desc}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showDefaultCheckbox && (
            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={e => setIsDefault(e.target.checked)}
                />
                Set as default template
              </label>
            </div>
          )}
        </div>

        <div className="template-editor-footer">
          <button className="btn btn-sm" onClick={onClose} disabled={saving}>
            Cancel
          </button>

          {mode === 'create' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || !name.trim() || !content.trim()}
            >
              {saving ? <Loader2 size={14} className="spinner" /> : null}
              Create Template
            </button>
          )}

          {mode === 'edit' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || !name.trim() || !content.trim()}
            >
              {saving ? <Loader2 size={14} className="spinner" /> : null}
              Save Changes
            </button>
          )}

          {mode === 'service-edit' && !saveAsNewMode && (
            <>
              {onSaveAsNew && (
                <button
                  className="btn btn-sm"
                  onClick={() => setSaveAsNewMode(true)}
                  disabled={saving}
                >
                  Save as New
                </button>
              )}
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSave}
                disabled={saving || !content.trim()}
              >
                {saving ? <Loader2 size={14} className="spinner" /> : null}
                Update &ldquo;{templateName || name}&rdquo;
              </button>
            </>
          )}

          {mode === 'service-edit' && saveAsNewMode && (
            <>
              <button className="btn btn-sm" onClick={() => setSaveAsNewMode(false)} disabled={saving}>
                Back
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSaveAsNew}
                disabled={saving || !newName.trim() || !content.trim()}
              >
                {saving ? <Loader2 size={14} className="spinner" /> : null}
                Create &amp; Apply
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
