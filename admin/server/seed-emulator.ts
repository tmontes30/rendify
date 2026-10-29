// Carga datos de prueba en los EMULADORES (nunca en producción).
// Uso: npm run emulators  (en otra terminal)  y luego  npm run seed:emu -w admin
export {};
process.argv.push('--emulator');
const { auth, db } = await import('./firebase.js');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Solo para emuladores.');

const cid = 'empresa-demo';
const comp = db.collection('companies').doc(cid);
await comp.set({ name: 'Empresa Demo', baseCurrency: 'CLP', active: true, createdAt: new Date() });
for (const [id, name] of Object.entries({ ventas: 'Ventas', operaciones: 'Operaciones' })) await comp.collection('areas').doc(id).set({ name, active: true });
for (const [id, name] of Object.entries({ transporte: 'Transporte', alimentacion: 'Alimentación', alojamiento: 'Alojamiento', materiales: 'Materiales', otros: 'Otros' }))
  await comp.collection('categories').doc(id).set({ name, active: true });

const people = [
  { key: 'worker', email: 'trabajador@demo.cl', displayName: 'Ana Trabajadora', areaId: 'ventas' },
  { key: 'boss', email: 'jefe@demo.cl', displayName: 'Carla Jefa', areaId: 'ventas' },
  { key: 'cfo', email: 'finanzas@demo.cl', displayName: 'Diego Finanzas', areaId: 'operaciones' },
];
const password = 'demo-12345';
const uids: Record<string, string> = {};
for (const p of people) {
  const existing = await auth.getUserByEmail(p.email).catch(() => null);
  const user = existing ?? (await auth.createUser({ email: p.email, password, displayName: p.displayName }));
  uids[p.key] = user.uid;
  await auth.setCustomUserClaims(user.uid, { companyId: cid });
}
await comp.collection('flows').doc('estandar').set({
  name: 'Estándar',
  levels: [
    { name: 'Jefe directo', minAmount: 0, approvers: [uids.boss] },
    { name: 'Finanzas', minAmount: 500000, approvers: [uids.cfo] },
  ],
  allApprovers: [uids.boss, uids.cfo],
  approverNames: { [uids.boss]: 'Carla Jefa', [uids.cfo]: 'Diego Finanzas' },
});
for (const p of people) {
  await db.collection('users').doc(uids[p.key]).set({
    email: p.email,
    displayName: p.displayName,
    companyId: cid,
    areaId: p.areaId,
    flowId: p.key === 'worker' ? 'estandar' : null,
    isApprover: p.key !== 'worker',
    active: true,
    createdAt: new Date(),
  });
}
console.log(`Listo. Usuarios de prueba (contraseña "${password}"):`);
for (const p of people) console.log(`  ${p.email}`);
process.exit(0);
