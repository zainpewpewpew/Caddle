// Gerbang untuk hasher kata sandi agar interleaving async dapat diuji deterministik, tanpa sleep.
// Argon2 tetap dihitung sungguhan; yang ditahan hanya kelanjutannya, sehingga jendela di antara
// "hash dibaca/dibuat" dan "hasilnya dipakai" (mis. login vs `npm run user:password` di proses lain)
// terbuka selama tes membutuhkannya.

/**
 * Memasang gerbang pada `hasher` di tempat (objek yang sama yang sudah dipegang service).
 * `hold(method)` menahan setiap panggilan `method` ('hash' | 'verify') berikutnya setelah hasil aslinya
 * dihitung, sampai `release()`. `arrived(n)` resolve setelah n panggilan tertahan.
 * @param {{ hash: Function, verify: Function }} hasher
 */
export function gateHasher(hasher) {
  const gates = new Map();

  for (const method of ['hash', 'verify']) {
    const original = hasher[method].bind(hasher);
    hasher[method] = async (...args) => {
      const result = await original(...args);
      const gate = gates.get(method);
      if (gate) {
        gate.arrivals += 1;
        for (const waiter of gate.waiters) if (gate.arrivals >= waiter.n) waiter.resolve();
        await gate.opened;
      }
      return result;
    };
  }

  return {
    hold(method) {
      let open;
      const gate = { arrivals: 0, waiters: [], opened: new Promise((resolve) => { open = resolve; }) };
      gates.set(method, gate);
      return {
        arrived: (n = 1) => new Promise((resolve) => {
          if (gate.arrivals >= n) resolve();
          else gate.waiters.push({ n, resolve });
        }),
        release() {
          if (gates.get(method) === gate) gates.delete(method);
          open();
        },
      };
    },
  };
}
