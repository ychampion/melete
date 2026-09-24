/**
 * Companies: every company in the person's life, what each one costs, what it
 * owes back, and what it said it would do.
 *
 * Nothing on this screen is a claim on its own. Each figure at the top is the
 * count of the rows under it and filters to them; each row opens the sentence
 * in the message it was read from. "Handle it" does not send anything — it
 * starts the job, and the job asks before the first message goes out, on the
 * same approval card every other job uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { companiesApi, currentSpaceId } from '../companies/api.ts';
import type { Filter } from '../companies/format.ts';
import { byCompany, inOrder, matches, money, sameFilter } from '../companies/format.ts';
import { CompanyHeader, EmptyLedger, LedgerDetailPanel, LedgerRow } from '../companies/Ledger.tsx';
import { TotalsRow, totalsOf } from '../companies/Totals.tsx';
import { OWED_LINE, owedHeadline } from '../copy/money-back.ts';
import { Icon } from '../design/icons.tsx';
import { Segmented } from '../design/primitives.tsx';
import { useMedia, useNow } from '../experience/hooks.ts';
import type { CompanyMap, LedgerDetail, ScanProgress } from '../experience/types.ts';
import { navigate, useRoute } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import '../companies/companies.css';

const SCAN_POLL_MS = 400;
const OWED: Filter = { kind: 'direction', value: 'owed_to_you' };

export function CompaniesScreen() {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [map, setMap] = useState<CompanyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>(null);
  const [grouped, setGrouped] = useState(true);
  // `?first=1` is the arrival from setup with an inbox just connected: the
  // first scan starts on its own, and its result leads with what is owed back.
  const first = useRoute().query.get('first') === '1';
  const [justScanned, setJustScanned] = useState(false);
  const firstScan = useRef(false);
  const ledOwed = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LedgerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const phone = useMedia('(max-width: 767px)');
  // The relative dates on the rows stay honest while the screen is open.
  const now = useNow(true, 60_000);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (space: string) => {
    const result = await companiesApi.map(space);
    if (result.data === null) setError(result.error ?? result.unavailable);
    else {
      setMap(result.data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let live = true;
    void currentSpaceId().then(async (result) => {
      if (!live) return;
      if (result.data === null) {
        setError(result.error ?? result.unavailable);
        setLoading(false);
        return;
      }
      setSpaceId(result.data);
      await load(result.data);
    });
    return () => {
      live = false;
      if (poll.current) clearInterval(poll.current);
    };
  }, [load]);

  // The detail is fetched when a row opens: the map carries the spans, the
  // detail carries the message text they index into.
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    void companiesApi.item(openId).then((result) => {
      if (!live) return;
      if (result.data === null)
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t open that' });
      else setDetail(result.data);
    });
    return () => {
      live = false;
    };
  }, [openId]);

  const startScan = () => {
    if (!spaceId || scanning) return;
    setScanning(true);
    setScan(null);
    void companiesApi.startScan(spaceId).then((started) => {
      if (started.data === null) {
        setScanning(false);
        setError(started.error ?? started.unavailable);
        return;
      }
      const scanId = started.data.scan_id;
      poll.current = setInterval(() => {
        void companiesApi.scan(spaceId, scanId).then((progress) => {
          if (progress.data === null) return;
          setScan(progress.data);
          if (progress.data.status === 'running') return;
          if (poll.current) clearInterval(poll.current);
          setScanning(false);
          if (progress.data.status === 'failed')
            setError(progress.data.error ?? 'The scan stopped before it finished.');
          else {
            setJustScanned(true);
            void load(spaceId);
          }
        });
      }, SCAN_POLL_MS);
    });
  };

  const act = async (id: string, what: 'settled' | 'dropped' | 'handle'): Promise<void> => {
    setBusy(true);
    if (what === 'handle') {
      const result = await companiesApi.handle(id);
      setBusy(false);
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t start it' });
        return;
      }
      navigate(`/chat/${result.data.job_id}`);
      return;
    }
    const result = await companiesApi.setStatus(id, what);
    setBusy(false);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t record that' });
      return;
    }
    const updated = result.data;
    setMap((previous) =>
      previous
        ? { ...previous, items: previous.items.map((row) => (row.id === id ? updated : row)) }
        : previous,
    );
    setDetail((previous) => (previous ? { ...previous, item: updated } : previous));
    toast({
      kind: 'ok',
      title: what === 'settled' ? 'Marked settled' : 'Taken off the list',
    });
  };

  const items = useMemo(
    () => (map ? map.items.filter((item) => matches(item, filter, now)) : []),
    [map, filter, now],
  );
  const groups = useMemo(() => (map ? byCompany(map, items, now) : []), [map, items, now]);
  const flat = useMemo(() => inOrder(items, now), [items, now]);
  const companyOf = (id: string) => map?.companies.find((company) => company.id === id);
  const nothingFound = map !== null && map.companies.length === 0 && map.items.length === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first scan starts once, when an empty map arrives
  useEffect(() => {
    if (!first || !nothingFound || !spaceId || firstScan.current) return;
    firstScan.current = true;
    startScan();
  }, [first, nothingFound, spaceId]);
  const owing = map
    ? new Set(map.items.filter((row) => matches(row, OWED, now)).map((row) => row.company_id)).size
    : 0;
  const owedTotal = map?.totals.owed_to_you_minor ?? 0;
  // A scan that finds money owed back leads with it: the owed rows, most urgent first.
  useEffect(() => {
    if (!justScanned || !map || ledOwed.current || owedTotal <= 0) return;
    ledOwed.current = true;
    setFilter(OWED);
    setGrouped(false);
  }, [justScanned, map, owedTotal]);
  const flatView = !grouped || phone;
  // A money figure pressed in reading order: say what the rows add up to.
  const pressed = map
    ? totalsOf(map.totals, map.companies.length, map.currency).find(
        (total) => total.filter !== null && sameFilter(total.filter, filter),
      )
    : undefined;
  const caption =
    pressed && flatView && (pressed.key === 'owed' || pressed.key === 'spend')
      ? `The rows that make ${pressed.figure}, most urgent first`
      : null;

  const rowOf = (item: (typeof flat)[number], showCompany: boolean) => (
    <div key={item.id}>
      <LedgerRow
        item={item}
        company={companyOf(item.company_id)}
        now={now}
        open={openId === item.id}
        showCompany={showCompany}
        onToggle={() => setOpenId(openId === item.id ? null : item.id)}
      />
      {openId === item.id ? (
        <LedgerDetailPanel
          detail={detail}
          busy={busy}
          onHandle={() =>
            detail?.item.job_id
              ? navigate(`/chat/${detail.item.job_id}`)
              : void act(item.id, 'handle')
          }
          onSettled={() => void act(item.id, 'settled')}
          onDrop={() => void act(item.id, 'dropped')}
        />
      ) : null}
    </div>
  );

  return (
    <Shell title="Companies" rail={false}>
      <div className="page">
        <div className="page-head" style={{ alignItems: 'flex-end' }}>
          <div className="col" style={{ gap: 6 }}>
            <h1>Companies</h1>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>
              What each company takes, what it owes back, and what it promised.
            </div>
          </div>
          {map && !nothingFound ? (
            <Segmented
              label="How the ledger is arranged"
              value={grouped ? 'company' : 'everything'}
              onChange={(next) => setGrouped(next === 'company')}
              options={[
                { value: 'company', label: 'By company' },
                { value: 'everything', label: 'Everything' },
              ]}
            />
          ) : null}
        </div>

        {error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p> : null}

        {map && !nothingFound ? (
          <div className="companies">
            {justScanned && owedTotal > 0 ? (
              <div className="col" style={{ gap: 4 }}>
                <p className="brief-line voice" style={{ color: 'var(--heading)' }}>
                  {owedHeadline(money(owedTotal, map.currency), owing)}
                </p>
                <p style={{ fontSize: 14, color: 'var(--muted)' }}>{OWED_LINE}</p>
              </div>
            ) : null}
            <TotalsRow
              totals={map.totals}
              companies={map.companies.length}
              currency={map.currency}
              filter={filter}
              onFilter={(next) => {
                setFilter(next);
                setOpenId(null);
              }}
            />
            {filter !== null ? (
              <div className="filter-line">
                <button
                  type="button"
                  className="filter-chip"
                  aria-label={`${items.length} of ${map.items.length} shown. Show everything`}
                  onClick={() => setFilter(null)}
                >
                  {items.length} of {map.items.length} shown
                  <Icon name="x" size={13} />
                </button>
                {caption ? <span className="filter-caption">{caption}</span> : null}
              </div>
            ) : null}
            <div className="ledger">
              {!flatView
                ? groups.map((group) => (
                    <div key={group.company.id}>
                      <CompanyHeader
                        company={group.company}
                        items={group.items}
                        currency={map.currency}
                      />
                      {group.items.map((item) => rowOf(item, false))}
                    </div>
                  ))
                : flat.map((item) => rowOf(item, true))}
              {items.length === 0 ? (
                <div style={{ padding: '28px 16px', fontSize: 14, color: 'var(--muted)' }}>
                  Nothing under that figure right now.
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {nothingFound || (loading === false && map === null && !error) ? (
          <div className="ledger">
            <EmptyLedger scanning={scanning} progress={scan} error={null} onScan={startScan} />
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
