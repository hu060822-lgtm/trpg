import { useState } from 'react';
import type { WorldCharacter, WorldCommand, WorldState } from '../../../src/world/types';
import { useAction } from '../hooks';

/**
 * Trading where the character stands: shops here, their own shop, direct trades, and the commission board.
 * Every command that moves value is sent with a fresh request id, so a double click never pays twice.
 */
export function Market({ world, me, send }: { world: WorldState; me: WorldCharacter; send: (c: WorldCommand) => Promise<unknown> }) {
  const { busy, error, run } = useAction();
  const eco = world.economy;
  const items = world.items;
  const bag = Object.values(items).filter((i) => i.holder.type === 'character' && i.holder.id === me.id && i.status === 'present');
  const here = Object.values(eco.shops).filter((s) => s.locationId === me.locationId && (s.open || s.ownerId === me.id));
  const mine = Object.values(eco.shops).find((s) => s.ownerId === me.id);
  const people = Object.values(world.characters).filter((c) => c.id !== me.id && c.locationId === me.locationId && c.status === 'alive');
  const trades = Object.values(eco.trades).filter((t) => t.status === 'pending' && (t.from === me.id || t.to === me.id));
  const board = Object.values(eco.commissions).filter((k) => ['published', 'accepted', 'submitted'].includes(k.status));
  const name = (id: string) => world.characters[id]?.name ?? (id.startsWith('team:') ? eco.teams[id.slice(5)]?.name ?? id : id);
  const go = (c: WorldCommand) => run(() => send(c));

  const [shopName, setShopName] = useState('');
  const [stock, setStock] = useState({ itemId: '', price: 10 });
  const [trade, setTrade] = useState({ to: '', coins: 0, itemId: '', wantCoins: 0 });
  const [post, setPost] = useState({ title: '', kind: 'gm' as 'gm' | 'deliver', text: '', template: '', qty: 1, reward: 10, days: 3 });
  const [deliver, setDeliver] = useState<string[]>([]);

  return (
    <div className="stack">
      <p className="small">身上有 <b>{me.coins}</b> 枚錢幣。</p>

      <div className="block">
        <h3>這裡的商店</h3>
        {here.length === 0 && <p className="muted small">這裡沒有開著的店。</p>}
        {here.map((s) => (
          <div key={s.id} className="stack" style={{ marginBottom: 10 }}>
            <b>{s.name}<span className="muted small">（{name(s.ownerId)}{s.open ? '' : '，暫停營業'}）</span></b>
            <ul className="list small">
              {s.listings.length === 0 && <li className="muted">架上是空的</li>}
              {s.listings.map((l) => (
                <li key={l.itemId}>
                  <span>{items[l.itemId]?.name ?? l.itemId}　{l.price} 枚</span>
                  {s.ownerId === me.id
                    ? <button disabled={busy} onClick={() => void go({ type: 'unstockItem', characterId: me.id, shopId: s.id, itemId: l.itemId })}>下架</button>
                    : <button disabled={busy || me.coins < l.price} onClick={() => void go({ type: 'buy', characterId: me.id, shopId: s.id, itemId: l.itemId })}>買下</button>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="block stack">
        <h3>我的商店</h3>
        {mine ? (
          <>
            <div className="row small">
              <span>{mine.name}，{mine.open ? '營業中' : '暫停營業'}</span>
              <button disabled={busy} onClick={() => void go({ type: 'setShopOpen', characterId: me.id, shopId: mine.id, open: !mine.open })}>{mine.open ? '暫停營業' : '開始營業'}</button>
            </div>
            {mine.locationId === me.locationId && bag.length > 0 && (
              <div className="row">
                <select aria-label="上架的物品" value={stock.itemId} onChange={(e) => setStock({ ...stock, itemId: e.target.value })}>
                  <option value="">選擇物品</option>
                  {bag.filter((i) => i.tradable && !i.boundTo).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
                <input aria-label="售價" type="number" min={1} style={{ width: 72 }} value={stock.price} onChange={(e) => setStock({ ...stock, price: Number(e.target.value) })} />
                <button disabled={busy || !stock.itemId} onClick={() => void go({ type: 'stockItem', characterId: me.id, shopId: mine.id, itemId: stock.itemId, price: stock.price })}>上架</button>
              </div>
            )}
          </>
        ) : (
          <div className="row">
            <input aria-label="商店名稱" placeholder="商店名稱" value={shopName} onChange={(e) => setShopName(e.target.value)} />
            <button disabled={busy || !shopName.trim()} onClick={() => void go({
              type: 'openShop', characterId: me.id, shopId: `shop-${me.id}`, name: shopName.trim(), description: '',
            })}>在這裡開店</button>
          </div>
        )}
      </div>

      <div className="block stack">
        <h3>直接交易</h3>
        {trades.map((t) => (
          <div key={t.id} className="small">
            {t.from === me.id ? `你向 ${name(t.to)}` : `${name(t.from)} 向你`}提出：給 {t.give.coins} 枚{t.give.itemIds.map((i) => `、${items[i]?.name ?? '物品'}`).join('')}，換 {t.want.coins} 枚
            <div className="row">
              {t.to === me.id && <button disabled={busy} onClick={() => void go({ type: 'acceptTrade', characterId: me.id, tradeId: t.id })}>接受</button>}
              {t.to === me.id && <button disabled={busy} onClick={() => void go({ type: 'declineTrade', characterId: me.id, tradeId: t.id })}>拒絕</button>}
              {t.from === me.id && <button disabled={busy} onClick={() => void go({ type: 'cancelTrade', characterId: me.id, tradeId: t.id })}>取消</button>}
            </div>
          </div>
        ))}
        {people.length > 0 ? (
          <div className="stack">
            <select aria-label="交易對象" value={trade.to} onChange={(e) => setTrade({ ...trade, to: e.target.value })}>
              <option value="">和誰交易</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="row small">
              <label>我給錢幣<input type="number" min={0} style={{ width: 72 }} value={trade.coins} onChange={(e) => setTrade({ ...trade, coins: Number(e.target.value) })} /></label>
              <label>我給物品
                <select value={trade.itemId} onChange={(e) => setTrade({ ...trade, itemId: e.target.value })}>
                  <option value="">不給</option>
                  {bag.filter((i) => i.tradable && !i.boundTo).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>
              <label>換對方錢幣<input type="number" min={0} style={{ width: 72 }} value={trade.wantCoins} onChange={(e) => setTrade({ ...trade, wantCoins: Number(e.target.value) })} /></label>
            </div>
            <button disabled={busy || !trade.to} onClick={() => void go({
              type: 'proposeTrade', characterId: me.id, to: trade.to,
              give: { coins: trade.coins, itemIds: trade.itemId ? [trade.itemId] : [] }, want: { coins: trade.wantCoins, itemIds: [] },
            })}>提出交易</button>
          </div>
        ) : <p className="muted small">要和同一個地點的人才能直接交易。</p>}
      </div>

      <div className="block stack">
        <h3>委託板</h3>
        {board.length === 0 && <p className="muted small">目前沒有委託。</p>}
        {board.map((k) => (
          <div key={k.id} className="small stack" style={{ gap: 4 }}>
            <span><b>{k.title}</b>　報酬 {k.reward} 枚，{name(k.issuerId)} 發布，期限 {new Date(k.deadline).toLocaleDateString()}</span>
            <span className="muted">{k.requirement.kind === 'deliver' ? `交付 ${k.requirement.qty} 件「${k.requirement.template}」` : `GM 驗收：${k.requirement.text}`}
              {k.contractorId ? `，${name(k.contractorId)} 已接下` : ''}{k.status === 'submitted' ? '，等待驗收' : ''}</span>
            <div className="row">
              {k.status === 'published' && k.issuerId !== me.id && <button disabled={busy} onClick={() => void go({ type: 'acceptCommission', characterId: me.id, commissionId: k.id })}>接下</button>}
              {k.status === 'published' && k.issuerId === me.id && <button disabled={busy} onClick={() => void go({ type: 'cancelCommission', characterId: me.id, commissionId: k.id })}>撤回</button>}
              {k.status === 'accepted' && k.contractorId === me.id && (
                <>
                  {k.requirement.kind === 'deliver' && bag.filter((i) => i.template === (k.requirement as { template: string }).template).map((i) => (
                    <label key={i.id} className="tick">
                      <input type="checkbox" checked={deliver.includes(i.id)} onChange={(e) => setDeliver(e.target.checked ? [...deliver, i.id] : deliver.filter((x) => x !== i.id))} />{i.name}
                    </label>
                  ))}
                  <button disabled={busy} onClick={() => void go({ type: 'submitCommission', characterId: me.id, commissionId: k.id, itemIds: deliver }).then(() => setDeliver([]))}>提交</button>
                </>
              )}
            </div>
          </div>
        ))}
        <details>
          <summary className="small">發布委託</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <input aria-label="委託標題" placeholder="標題" value={post.title} onChange={(e) => setPost({ ...post, title: e.target.value })} />
            <select aria-label="完成條件" value={post.kind} onChange={(e) => setPost({ ...post, kind: e.target.value as 'gm' | 'deliver' })}>
              <option value="gm">由 GM 驗收</option>
              <option value="deliver">交付物品</option>
            </select>
            {post.kind === 'gm'
              ? <input aria-label="要做到什麼" placeholder="要做到什麼" value={post.text} onChange={(e) => setPost({ ...post, text: e.target.value })} />
              : <div className="row"><input aria-label="物品種類" placeholder="物品種類，例如 moonherb" value={post.template} onChange={(e) => setPost({ ...post, template: e.target.value })} />
                <input aria-label="數量" type="number" min={1} style={{ width: 64 }} value={post.qty} onChange={(e) => setPost({ ...post, qty: Number(e.target.value) })} /></div>}
            <div className="row small">
              <label>報酬<input type="number" min={1} style={{ width: 72 }} value={post.reward} onChange={(e) => setPost({ ...post, reward: Number(e.target.value) })} /></label>
              <label>幾天內<input type="number" min={1} max={30} style={{ width: 64 }} value={post.days} onChange={(e) => setPost({ ...post, days: Number(e.target.value) })} /></label>
            </div>
            <button disabled={busy || !post.title.trim() || post.reward > me.coins} onClick={() => void go({
              type: 'postCommission', characterId: me.id, title: post.title.trim(), reward: post.reward,
              deadline: new Date(Date.now() + post.days * 86_400_000).toISOString(),
              requirement: post.kind === 'gm' ? { kind: 'gm', text: post.text.trim() } : { kind: 'deliver', template: post.template.trim(), qty: post.qty },
            })}>發布（報酬會先鎖定）</button>
          </div>
        </details>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
