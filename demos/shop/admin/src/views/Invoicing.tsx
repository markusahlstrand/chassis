import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, kr, type Underlag, type UnderlagLine } from '../api';

export function Invoicing({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [list, setList] = useState<Underlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<UnderlagLine[]>([]);

  const load = useCallback(() => {
    setError(null);
    void api
      .invoicing()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const expand = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    try {
      const detail = await api.underlag(id);
      setLines(detail.lines);
      setOpen(id);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const doExport = async (id: string, number: number) => {
    try {
      await api.exportUnderlag(id);
      notify(`Underlag ${number} exporterat — nu låst`, true);
      load();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  if (error) return <div className="notice deny">{error}</div>;
  if (!list) return <div className="notice">Laddar underlag…</div>;

  return (
    <>
      <div className="sec-head">
        <div className="eyebrow">Byggt av engine-invoicing</div>
        <h1>Invoice basis</h1>
        <p>
          Skapas automatiskt när en order betalas mot faktura — samma engine som verkstadsdemot,
          en ny händelsekälla. Ett exporterat underlag är låst och kan aldrig redigeras.
        </p>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th className="num">Nr</th>
              <th className="l">Status</th>
              <th className="num">Summa</th>
              <th className="l">Åtgärd</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={4}><div className="notice">Inga underlag ännu — lägg en order mot faktura.</div></td></tr>
            )}
            {list.map((u) => (
              <Fragment key={u.id}>
                <tr className="clickable" onClick={() => expand(u.id)}>
                  <td className="num">#{u.number}</td>
                  <td><span className={`pill ${u.status}`}>{u.status}</span></td>
                  <td className="num">{kr(u.total)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {u.status === 'open' ? (
                      <button className="btn sm ghost" onClick={() => doExport(u.id, u.number)}>
                        Exportera
                      </button>
                    ) : (
                      <span className="muted">låst</span>
                    )}
                  </td>
                </tr>
                {open === u.id &&
                  lines.map((l) => (
                    <tr key={l.id}>
                      <td />
                      <td colSpan={2}>
                        <span className="muted num">{l.qty} {l.unit}</span> · {l.description}
                      </td>
                      <td className="num">{kr(l.line_total_amount)}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
