import { useState, useEffect } from 'react';
import {
  RefreshCw, Loader2, CheckCircle, Download, Package,
  Clock, DollarSign, ArrowUpRight, Filter,
} from 'lucide-react';
import { integrationsApi } from '../services/api';

type CollectedLead = {
  id: string;
  thumbtackId: string;
  batchId: string | null;
  capturedAt: string;
  collectedAt: string;
  source: string | null;
  thumbtackStatus: string | null;
  imported: boolean;
  importedAt: string | null;
  needsRefetch: boolean;
  lastActivityAt: string | null;
};

type BudgetSnapshot = {
  id: string;
  snapshotType: string;
  scopeCategory: string | null;
  scopeLocation: string | null;
  weeklyBudget: string;
  currency: string;
  capturedAt: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string | null;
  active: boolean;
};

function LeadStatusBadge({ lead }: { lead: CollectedLead }) {
  if (lead.imported) {
    return (
      <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
        <CheckCircle size={12} /> Imported
      </span>
    );
  }
  if (lead.needsRefetch) {
    return (
      <span className="px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
        <ArrowUpRight size={12} /> Needs Refetch
      </span>
    );
  }
  return (
    <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
      <Clock size={12} /> Pending
    </span>
  );
}

type TabId = 'leads' | 'budgets';
type LeadFilter = 'all' | 'pending' | 'imported' | 'refetch';

export function ExtensionSync() {
  const [activeTab, setActiveTab] = useState<TabId>('leads');
  const [leads, setLeads] = useState<CollectedLead[]>([]);
  const [snapshots, setSnapshots] = useState<BudgetSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<LeadFilter>('all');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [leadsRes, snapshotsRes] = await Promise.all([
        integrationsApi.getCollectedLeads(),
        integrationsApi.getBudgetSnapshots(),
      ]);
      setLeads(leadsRes.leads);
      setSnapshots(snapshotsRes.snapshots);
    } catch (err) {
      console.error('Failed to load extension data:', err);
    } finally {
      setLoading(false);
    }
  };

  const filteredLeads = leads.filter((l) => {
    if (filter === 'pending') return !l.imported;
    if (filter === 'imported') return l.imported;
    if (filter === 'refetch') return l.needsRefetch;
    return true;
  });

  const pendingLeads = leads.filter((l) => !l.imported);
  const importedLeads = leads.filter((l) => l.imported);
  const refetchLeads = leads.filter((l) => l.needsRefetch);

  const toggleSelect = (thumbtackId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(thumbtackId)) next.delete(thumbtackId);
      else next.add(thumbtackId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pendingFiltered = filteredLeads.filter((l) => !l.imported);
    if (selected.size === pendingFiltered.length && pendingFiltered.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingFiltered.map((l) => l.thumbtackId)));
    }
  };

  const handleImport = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      setImporting(true);
      setImportResult(null);
      const result = await integrationsApi.importNegotiationBatch(ids);
      await integrationsApi.markLeadsImported(ids.filter((id) => {
        const r = result.results?.find((r) => r.negotiationId === id);
        return r && !r.error;
      }));
      setImportResult(`Imported ${result.imported} leads (${result.skipped} skipped, ${result.errors?.length || 0} errors)`);
      setSelected(new Set());
      await loadData();
    } catch (err: any) {
      setImportResult(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleImportSelected = () => handleImport(Array.from(selected));
  const handleImportAllPending = () => handleImport(pendingLeads.map((l) => l.thumbtackId));

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };


  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      {/* Header */}
      <section>
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
          Extension <span className="gradient-text">Sync</span>
        </h1>
        <p className="text-slate-500 mt-1 md:mt-2 text-sm md:text-lg">
          View and import data collected by the Chrome extension
        </p>
      </section>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('leads')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            activeTab === 'leads'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Collected IDs ({leads.length})
        </button>
        <button
          onClick={() => setActiveTab('budgets')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            activeTab === 'budgets'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Budget History ({snapshots.length})
        </button>
        <button
          onClick={loadData}
          disabled={loading}
          className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : activeTab === 'leads' ? (
        <>
          {/* Stats */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-50 text-blue-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <Package className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Total Collected</p>
              <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{leads.length}</h3>
            </div>
            <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-amber-50 text-amber-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <Clock className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Pending</p>
              <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{pendingLeads.length}</h3>
            </div>
            <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-green-50 text-green-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <CheckCircle className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Imported</p>
              <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{importedLeads.length}</h3>
            </div>
            <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-orange-50 text-orange-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <ArrowUpRight className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Needs Refetch</p>
              <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{refetchLeads.length}</h3>
            </div>
          </section>

          {/* Import result */}
          {importResult && (
            <div className={`p-4 rounded-xl text-sm font-medium ${importResult.includes('failed') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
              {importResult}
            </div>
          )}

          {/* Filter + Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-slate-400" />
              {(['all', 'pending', 'imported', 'refetch'] as LeadFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setSelected(new Set()); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filter === f
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {f === 'all' ? 'All' : f === 'pending' ? 'Pending' : f === 'imported' ? 'Imported' : 'Needs Refetch'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              {selected.size > 0 && (
                <button
                  onClick={handleImportSelected}
                  disabled={importing}
                  className="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {importing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  Import Selected ({selected.size})
                </button>
              )}
              {pendingLeads.length > 0 && (
                <button
                  onClick={handleImportAllPending}
                  disabled={importing}
                  className="px-4 py-2 rounded-xl text-sm font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {importing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  Import All Pending ({pendingLeads.length})
                </button>
              )}
            </div>
          </div>

          {filteredLeads.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-100 p-10 text-center">
              <Package className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">No collected IDs found</p>
              <p className="text-slate-400 text-sm mt-1">Collected conversation IDs from the Chrome extension will appear here</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block bg-white rounded-2xl border border-slate-100 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">
                        <input
                          type="checkbox"
                          checked={selected.size > 0 && selected.size === filteredLeads.filter(l => !l.imported).length}
                          onChange={toggleSelectAll}
                          className="rounded border-slate-300"
                        />
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Thumbtack ID</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Collected</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">TT Status</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Source</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Batch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeads.map((lead) => (
                      <tr key={lead.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-3 px-4">
                          {!lead.imported && (
                            <input
                              type="checkbox"
                              checked={selected.has(lead.thumbtackId)}
                              onChange={() => toggleSelect(lead.thumbtackId)}
                              className="rounded border-slate-300"
                            />
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <code className="text-sm font-mono text-slate-700 bg-slate-50 px-2 py-0.5 rounded">
                            {lead.thumbtackId}
                          </code>
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-600">{formatDate(lead.collectedAt)}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{lead.thumbtackStatus || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{lead.source || '-'}</td>
                        <td className="py-3 px-4"><LeadStatusBadge lead={lead} /></td>
                        <td className="py-3 px-4 text-xs text-slate-400 font-mono">{lead.batchId?.slice(0, 8) || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {filteredLeads.map((lead) => (
                  <div key={lead.id} className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {!lead.imported && (
                          <input
                            type="checkbox"
                            checked={selected.has(lead.thumbtackId)}
                            onChange={() => toggleSelect(lead.thumbtackId)}
                            className="rounded border-slate-300"
                          />
                        )}
                        <code className="text-xs font-mono text-slate-700 bg-slate-50 px-2 py-0.5 rounded break-all">
                          {lead.thumbtackId}
                        </code>
                      </div>
                      <LeadStatusBadge lead={lead} />
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>{formatDate(lead.collectedAt)}</span>
                      <span>{lead.thumbtackStatus || lead.source || 'No source'}</span>
                    </div>
                    {lead.importedAt && (
                      <p className="text-xs text-green-600">Imported: {formatDate(lead.importedAt)}</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        /* Budget History Tab */
        <>
          {snapshots.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-100 p-10 text-center">
              <DollarSign className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">No budget snapshots yet</p>
              <p className="text-slate-400 text-sm mt-1">Budget data captured by the Chrome extension will appear here</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block bg-white rounded-2xl border border-slate-100 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Weekly Budget</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Category</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Location</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Captured</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Effective</th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((snap) => (
                      <tr key={snap.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-3 px-4">
                          <span className="text-lg font-bold text-slate-900">
                            ${Number(snap.weeklyBudget).toFixed(0)}
                          </span>
                          <span className="text-xs text-slate-400 ml-1">/{snap.currency}/wk</span>
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-600">{snap.scopeCategory || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-600">{snap.scopeLocation || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{formatDate(snap.capturedAt)}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">
                          {formatDate(snap.effectiveFrom)}
                          {snap.effectiveTo ? ` - ${formatDate(snap.effectiveTo)}` : ' - now'}
                        </td>
                        <td className="py-3 px-4">
                          {snap.active ? (
                            <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold">Active</span>
                          ) : (
                            <span className="px-2.5 py-1 bg-slate-100 text-slate-500 rounded-full text-xs font-bold">Closed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {snapshots.map((snap) => (
                  <div key={snap.id} className="bg-white rounded-2xl border border-slate-100 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold text-slate-900">
                        ${Number(snap.weeklyBudget).toFixed(0)}<span className="text-xs text-slate-400 ml-1 font-normal">/{snap.currency}/wk</span>
                      </span>
                      {snap.active ? (
                        <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold">Active</span>
                      ) : (
                        <span className="px-2.5 py-1 bg-slate-100 text-slate-500 rounded-full text-xs font-bold">Closed</span>
                      )}
                    </div>
                    {(snap.scopeCategory || snap.scopeLocation) && (
                      <p className="text-sm text-slate-600">
                        {[snap.scopeCategory, snap.scopeLocation].filter(Boolean).join(' - ')}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>Captured: {formatDate(snap.capturedAt)}</span>
                      <span>
                        {formatDate(snap.effectiveFrom)}{snap.effectiveTo ? ` - ${formatDate(snap.effectiveTo)}` : ' - now'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
