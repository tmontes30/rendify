// Carga datos de prueba en los EMULADORES (nunca en producción).
// Uso: npm run emulators  (en otra terminal)  y luego  npm run seed:emu -w admin
process.argv.push('--emulator');
const { auth, db } = await import('./firebase.js');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Solo para emuladores.');

const areas = { ventas: 'Ventas', operaciones: 'Operaciones' };
const categories = { transporte: 'Transporte', alimentacion: 'Alimentación', alojamiento: 'Alojamiento', materiales: 'Materiales', otros: 'Otros' };

for (const [id, name] of Object.entries(areas)) await db.collection('areas').doc(id).set({ name, active: true });
for (const [id, name] of Object.entries(categories)) await db.collection('categories').doc(id).set({ name, active: true });

const people = [
  { email: 'trabajador@demo.cl', displayName: 'Ana Trabajadora', role: 'worker', areaId: 'ventas' },
  { email: 'jefe@demo.cl', displayName: 'Carla Jefa', role: 'manager', areaId: 'ventas' },
  { email: 'ops@demo.cl', displayName: 'Diego Operaciones', role: 'worker', areaId: 'operaciones' },
];
const password = 'demo-12345';
for (const p of people) {
  const existing = await auth.getUserByEmail(p.email).catch(() => null);
  const user = existing ?? (await auth.createUser({ email: p.email, password, displayName: p.displayName }));
  await auth.setCustomUserClaims(user.uid, { role: p.role, areaId: p.areaId });
  await db.collection('users').doc(user.uid).set({ ...p, active: true, createdAt: new Date() });
}
console.log(`Listo. Usuarios de prueba (contraseña "${password}"):`);
for (const p of people) console.log(`  ${p.email}  (${p.role}, ${p.areaId})`);
process.exit(0);
