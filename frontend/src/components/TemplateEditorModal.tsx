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
  { name: '{accountName}', desc: 'Your business name' },
  { name: '{category}', desc: 'Service category' },
  { name: '{city}', desc: 'Customer city' },
  { name: '{state}', desc: 'Customer state' },
];

export const SMS_VARIABLES: TemplateVariable[] = [
  { name: '{account.name}', desc: 'Your business name' },
  { name: '{lead.name}', desc: 'Customer name' },
  { name: '{lead.phone}', desc: 'Customer phone' },
  { name: '{lead.service}', desc: 'Service category' },
  { name: '{lead.location}', desc: 'City, State' },
  { name: '{lead.zip}', desc: 'ZIP code' },
  { name: '{lead.message}', desc: 'Customer request message' },
  { name: '{lead.serviceDescription}', desc: 'Detailed service description' },
  { name: '{lead.addons}', desc: 'Service add-ons' },
  { name: '{lead.frequency}', desc: 'Service frequency' },
  { name: '{lead.bedrooms}', desc: 'Number of bedrooms' },
  { name: '{lead.bathrooms}', desc: 'Number of bathrooms' },
  { name: '{lead.price}', desc: 'Lead price/cost' },
  { name: '{lead.pets}', desc: 'Pet information' },
  { name: '{lead.estimate}', desc: 'Estimated cost/quote' },
  { name: '{lead.dates}', desc: 'Requested date/schedule' },
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
  saveError?: string | null;
  onSave: (data: { name: string; content: string; isDefault?: boolean; delay?: string }) => void;
  onSaveAsNew?: (data: { name: string; content: string }) => void;
  /**
   * When provided, the modal renders an editable "Send after" delay
   * input above the content textarea. Used by the follow-up step editor
   * to edit both delay + message in a single popup.
   */
  initialDelay?: string;
  showDelayField?: boolean;
  delayPresets?: string[];
  /**
   * When true, hides the Content textarea entirely (used for AI-mode
   * follow-up steps where the message is generated, not authored).
   * Pair with contentPlaceholder to show an explanatory note.
   */
  hideContentField?: boolean;
  /** Optional note shown in place of the Content textarea when hidden. */
  contentPlaceholder?: React.ReactNode;
}

export function TemplateEditorModal({
  isOpen, onClose, mode, initialName, initialContent,
  templateName, saving, variables, existingNames = [],
  showDefaultCheckbox, initialIsDefault, saveError,
  onSave, onSaveAsNew,
  initialDelay, showDelayField, delayPresets,
  hideContentField, contentPlaceholder,
}: TemplateEditorModalProps) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [isDefault, setIsDefault] = useState(initialIsDefault || false);
  const [delay, setDelay] = useState(initialDelay || '');
  const [saveAsNewMode, setSaveAsNewMode] = useState(false);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setContent(initialContent);
      setIsDefault(initialIsDefault || false);
      setDelay(initialDelay || '');
      setSaveAsNewMode(false);
      setNewName('');
      setNameError(null);
    }
  }, [isOpen, initialName, initialContent, initialIsDefault, initialDelay]);

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
    onSave({
      name: name.trim(),
      content: content.trim(),
      isDefault,
      ...(showDelayField ? { delay: delay.trim() } : {}),
    });
  }

  function handleSaveAsNew() {
    if (!validateName(newName)) return;
    onSaveAsNew?.({ name: newName.trim(), content: content.trim() });
  }

  const title = mode === 'create' ? 'Create Template' : 'Edit Template';

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl p-8 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-all"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          {(mode === 'create' || mode === 'edit') && (
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Template Name</label>
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setNameError(null); }}
                placeholder="e.g., Follow-up Message"
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
              {nameError && !saveAsNewMode && (
                <p className="text-sm text-red-600 font-medium">{nameError}</p>
              )}
            </div>
          )}

          {mode === 'service-edit' && !saveAsNewMode && (
            <div className="px-4 py-3 bg-blue-50 rounded-xl border border-blue-100 text-sm text-slate-700">
              Editing: <strong className="text-slate-900">{templateName || name}</strong>
            </div>
          )}

          {mode === 'service-edit' && saveAsNewMode && (
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">New Template Name</label>
              <input
                type="text"
                value={newName}
                onChange={e => { setNewName(e.target.value); setNameError(null); }}
                placeholder="Enter template name"
                autoFocus
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
              {nameError && (
                <p className="text-sm text-red-600 font-medium">{nameError}</p>
              )}
            </div>
          )}

          {showDelayField && (
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Send after</label>
              <input
                type="text"
                value={delay}
                onChange={e => setDelay(e.target.value)}
                placeholder="e.g. 2 min, 1 hour, 1 day, 1 week"
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
              {delayPresets && delayPresets.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {delayPresets.map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setDelay(p)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all ${
                        delay === p ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-400">How long to wait after the previous step (or initial reply) before this message goes out.</p>
            </div>
          )}

          {!hideContentField ? (
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Content</label>
              <textarea
                ref={contentRef}
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Enter template content..."
                rows={8}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none font-sans"
              />
            </div>
          ) : contentPlaceholder ? (
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Message</label>
              <div className="px-4 py-3 bg-violet-50/40 border border-violet-100 rounded-xl text-sm text-slate-600 leading-relaxed">
                {contentPlaceholder}
              </div>
            </div>
          ) : null}

          {variables.length > 0 && !hideContentField && (
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-700">
                Variables <span className="text-xs font-normal text-slate-500">(click to insert at cursor)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {variables.map(v => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => insertVariable(v.name)}
                    title={v.desc}
                    className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-xs font-mono font-medium border border-blue-100 hover:bg-blue-100 transition-all"
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showDefaultCheckbox && (
            <div className="flex items-center gap-3 pt-2">
              <input
                type="checkbox"
                id="default-checkbox"
                checked={isDefault}
                onChange={e => setIsDefault(e.target.checked)}
                className="w-4 h-4 text-blue-600 bg-slate-50 border-slate-300 rounded focus:ring-2 focus:ring-blue-500"
              />
              <label htmlFor="default-checkbox" className="text-sm font-medium text-slate-700 cursor-pointer">
                Set as default template
              </label>
            </div>
          )}
        </div>

        {saveError && (
          <div className="mt-4 px-4 py-3 bg-red-50 border border-red-100 rounded-xl text-sm text-red-600 font-medium">
            {saveError}
          </div>
        )}

        <div className="flex gap-3 mt-8 pt-6 border-t border-slate-100">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>

          {mode === 'create' && (
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !content.trim()}
              className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              Create Template
            </button>
          )}

          {mode === 'edit' && (
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !content.trim()}
              className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              Save Changes
            </button>
          )}

          {mode === 'service-edit' && !saveAsNewMode && (
            <>
              {onSaveAsNew && (
                <button
                  onClick={() => setSaveAsNewMode(true)}
                  disabled={saving}
                  className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save as New
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving || (!hideContentField && !content.trim())}
                className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                Update &ldquo;{templateName || name}&rdquo;
              </button>
            </>
          )}

          {mode === 'service-edit' && saveAsNewMode && (
            <>
              <button
                onClick={() => setSaveAsNewMode(false)}
                disabled={saving}
                className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                onClick={handleSaveAsNew}
                disabled={saving || !newName.trim() || !content.trim()}
                className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                Create &amp; Apply
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
