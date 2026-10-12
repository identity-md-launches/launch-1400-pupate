"use client";

import { avgCost, eth, int, nextSeatPrice, pct, ripeness } from "@/lib/sim";
import { Chrysalis } from "./Chrysalis";
import { Flash } from "./Flash";
import { useSim } from "./SimContext";

/// The vault's specimen sheet: the figures of the moment, on the overview page under the hood.
export function VaultSheet() {
  const s = useSim();
  const progress = Math.min(s.seatPot / nextSeatPrice(s), 1);
  const ripest = s.seats.reduce((best, x) => (ripeness(x) > ripeness(best) ? x : best), s.seats[0]);
  return (
    <aside className="panel sheet" aria-label="The vault">
      <div className="title">
        <span className="serif">The vault, today</span>
        <span className="label">specimen sheet</span>
      </div>
      <div>
        <div className="fig num">
          {pct(progress)}
          <small>of the next seat</small>
        </div>
        <div className="meter" role="img" aria-label="Seat pot against the reference price" style={{ marginTop: 14 }}>
          <i style={{ ["--w" as string]: `${(progress * 100).toFixed(1)}%` }} />
        </div>
      </div>
      <div className="plate">{ripest ? <Chrysalis ripe={ripeness(ripest)} id="sheet" /> : <Chrysalis ripe={0} id="sheet" />}</div>
      <div className="rows">
        <Lead k="Reference price" v={eth(s.floor)} note="IMD oracle, lowest listing" />
        <Lead k="Seat pot" v={eth(s.seatPot)} />
        <Lead k="Burn pot" v={eth(s.burnPot)} />
        <Lead k="Seats held" v={String(s.seats.length)} note={s.seats.length ? `avg cost ${eth(avgCost(s))}` : undefined} />
        <Lead k="PUPATE burned" v={int(s.burned)} note={`${((s.burned / 1e9) * 100).toFixed(2)}% of supply`} />
        <Lead k="Tax collected" v={eth(s.taxCollected, 1)} note={`${eth(s.hookWaiting)} waiting in the hook`} />
      </div>
    </aside>
  );
}

/// A labelled figure with a dotted leader, the way a specimen label reads.
export function Lead({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="lead">
      <span className="k">{k}</span>
      <span className="dots" aria-hidden="true" />
      <span className="v num">
        <Flash>{v}</Flash>
        {note ? <span className="dim"> · {note}</span> : null}
      </span>
    </div>
  );
}
