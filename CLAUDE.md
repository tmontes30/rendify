# Rendify — contexto del proyecto

**Rendify**: plataforma de **rendición de gastos multiempresa** (nombre comercial elegido por el owner). El owner (Tomás Montes, `tmontes30`) vende el servicio a empresas (EuroCapital, Agroplas, Montes Service…). Cada empresa tiene sus usuarios, que rinden gastos y los aprueban en **flujos por niveles**. Todo lo administra el owner desde un **panel local** en su PC.

Idioma del producto y del código (textos, comentarios, mensajes): **español**. Moneda base habitual: CLP.

## Mapa del repositorio

```
shared/          Código común (TS puro, sin build): tipos, monedas, estados, reglas de negocio, logo, CSS
  src/index.ts   ← modelo de datos + lógica compartida (LEER PRIMERO)
  styles.css     ← único CSS de web y panel (tokens claro/oscuro)
  Logo.tsx       ← logo; variant="admin" = gris (panel owner)
web/             App pública (React + Vite) → GitHub Pages
  src/auth.tsx   ← sesión: claims + perfil + empresa + área + flujo
  src/data.ts    ← TODAS las lecturas/escrituras a Firestore de la web
  src/pages/     MyReports, ReportEditor (crear/editar), ReportPage (ver/decidir/pagar), Approvals, Payments, People + AdminFlows (admin. de personal), BulkUpload, Profile, Login
  src/adminData.ts ← operaciones del administrador de personal (crear cuentas con app secundaria, perfiles, flujos)
  src/components ReportRow (fila desplegable con avance), Layout (barra lateral)
admin/           Panel del owner, SOLO local (127.0.0.1:5050)
  server/        Express + Firebase Admin SDK (salta las reglas)
    api.ts       ← todos los endpoints /api/*
    firebase.ts  ← init Admin SDK, config local, modo emulador
    index.ts     ← seguridad local (token, Host/Origin, CSP) y arranque
  ui/src/        React: Dashboard, Notifications, Reports, Companies, Users, Flows, Catalog
firebase/        firestore.rules + índices + tests de reglas (vitest + emulador)
.github/workflows/deploy-web.yml   build y publicación de web/ en Pages
```

## Despliegue y entorno

- **Web pública:** https://cavedevz.com/rendify/ (GitHub Pages del repo `tmontes30/rendify`, dominio propio del usuario). Cada push a `main` la publica. Los secretos `VITE_FIREBASE_*` están en GitHub Actions.
- **Firebase:** proyecto `rendiciones-aa911`, plan **Spark (gratis)**, Firestore en `southamerica-west1`, Auth solo email/contraseña, contraseñas mín. 10, protección contra enumeración de correos, dominios autorizados: `localhost`, `127.0.0.1`, `cavedevz.com`, `rendiciones-aa911.firebaseapp.com`.
- **Clave Admin SDK:** `C:/Users/catal/secretos/rendiciones-aa911-admin.json` (fuera del repo y de OneDrive). Ruta configurada en `admin/config.local.json` (gitignored). **Nunca** leerla, mostrarla ni subirla.
- **Windows:** Node en `C:\Program Files\nodejs` (en Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"`). Java 21 en `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` (para emuladores: exportar `JAVA_HOME` y agregar `$JAVA_HOME/bin` al PATH).
- **Git:** el repo usa credenciales de `gh` (config local) porque Windows tiene guardada otra cuenta (`tmontesfalabellacl`). Commits con email noreply `268445412+tmontes30@users.noreply.github.com`.

### Comandos

```bash
npm run admin            # panel owner (build UI + servidor; abre navegador con #t=<token>)
npm run test:rules       # tests de reglas en emulador (necesita Java)
npm run deploy:rules     # publica firestore.rules + índices (npx firebase deploy --only firestore)
npm run typecheck        # tsc de web y admin
npm run build -w web     # build de la web
npm run emulators / admin:emu / seed:emu -w admin / dev:emu -w web   # todo local con datos demo
```

Al reiniciar el panel: matar el proceso que escucha en el puerto 5050 (PowerShell `Get-NetTCPConnection -LocalPort 5050`), porque detener la tarea de npm no siempre mata el proceso hijo de node. El token cambia en cada inicio.

## Modelo de datos (Firestore)

```
users/{uid}                         perfil (fuente de verdad del acceso)
  email, displayName, companyId, areaId, flowId|null, isApprover, isPayer, paymentsUser, companyAdmin, active, createdAt, createdBy?
companies/{cid}                     name, baseCurrency, active, createdAt
  areas/{id}, categories/{id}       name, active   (al crear empresa se cargan DEFAULT_AREAS/DEFAULT_CATEGORIES)
  flows/{fid}                       name, levels[{name, minAmount, approvers[uid]}], payerUid,
                                    allApprovers[uid] (= aprobadores de todos los niveles + payer), approverNames{uid:name}
  reports/{rid}                     ownerUid, ownerName, areaId, flowId, title, periodFrom, periodTo, status,
                                    totals{CUR: minor}, itemCount, currentLevel, currentApprovers[uid],
                                    approverUids[uid] (copia de flow.allApprovers al enviar), approvals[Approval],
                                    createdAt, updatedAt, submittedAt, decidedAt, ownerReview{at,comment,decision},
                                    paidAt, payment{uid,name,method,reference,paidOn,comment}, lastNotice{kind,level,at}
    items/{iid}                     date, categoryId, description, vendor, docType, docNumber, amount (entero, unidad mínima), currency
```

- **Acceso por perfil (sin claims):** las reglas usan solo `users/{uid}` (`companyId`, `active`, roles); el owner aún pone el claim `{ companyId }` pero no se usa (las cuentas creadas por el administrador de personal desde la web no lo tienen). Deshabilitar o mover de empresa corta el acceso al instante.
- **Montos** siempre enteros en unidad mínima (`toMinor`/`fromMinor`/`formatMoney`). Multimoneda: totales por moneda, sin conversión.
- `Approval = { level, levelName, uid, name, decision: 'approved'|'rejected', comment, atMs }` (atMs porque serverTimestamp no se permite dentro de arrays).

## Reglas de negocio (implementadas en `shared/src/index.ts`, reforzadas en reglas)

- **Estados:** `draft → pending → approved → paid`; `rejected` vuelve editable al dueño (draft y rejected son editables).
- **Flujo por niveles:** `levels[0]` = primero en revisar; el último = aprobación final. En el editor del panel se muestran **al revés** (arriba el más importante) porque el owner los crea de más importante a menos.
- **Monto mínimo por nivel** (en moneda base de la empresa): el nivel se activa si el total lo alcanza; con gastos en otra moneda se activa siempre. El nivel 0 siempre se activa. `nextRequiredLevel()` lo calcula (en el navegador del aprobador, con totales recalculados desde los ítems).
- **Nadie aprueba lo propio.** `startLevel()`: si quien envía es aprobador de su propio flujo, la rendición parte en el nivel siguiente al más alto donde aparece; si es el último nivel, parte en `levels.length` con `currentApprovers = []` → **la aprueba el owner** (se muestra "Te toca a ti").
- **Quién paga (`payerUid`):** usuario de la empresa con la casilla **"Usuario de pagos"** (`paymentsUser`, la marca el owner en Usuarios; el servidor rechaza un payer sin ella). Está en `allApprovers` para leer las rendiciones del flujo, pero no aprueba. Si el owner cambia el payer de un flujo, `syncReportViewers` actualiza `approverUids` de las rendiciones ya enviadas. `isApprover` se calcula desde los niveles; `isPayer` desde `payerUid`.
- **Pagos en la web (`/pagos`, solo `paymentsUser`):** pestañas Por pagar (`approved`) / Pagadas (`paid`) / Todas, con totales del mes. El payer del flujo registra el pago (`registerPayment`: método transferencia/efectivo/cheque/otro, N° comprobante, fecha, comentario) → `status: paid` + `payment`. Reglas: solo si `paymentsUser`, es el `payerUid` del flujo, la rendición está `approved` y no es propia. El owner también puede marcar pagada desde el panel (queda `payment.uid = 'owner'`).
- **Asignación automática:** al guardar un flujo, sus aprobadores (y payer) sin flujo quedan con `flowId` = ese flujo.
- **Usuario de pagos en la web:** ve solo "Pagos" (+ "Por aprobar" si además es aprobador) y entra directo a `/pagos`; no rinde gastos y no se le asigna flujo automáticamente.
- **Suspensión de empresa** (mensualidad impaga): en Empresas, "⏸ Suspender servicio" pone `active: false` + `suspendedAt` + `suspendedReason`. Las reglas (`member()` exige empresa activa; `belongsTo()` solo permite leer el doc de la empresa) bloquean todo al instante; la web muestra "Servicio suspendido temporalmente". "▶ Reactivar servicio" lo devuelve tal cual. Los datos no se borran y no genera notificaciones.
- **Facturación del servicio (mensualidad de cada empresa):** se guarda en `billing/{cid}` (colección sin reglas → solo el panel la lee; los usuarios de la empresa no la ven): `dueDate`, `billingDay`, `amount`, `currency`, `contactName`, `contactEmail`, `lastPaidAt`, `lastPaidFor`, `lastReminderAt`. Estados: `ok` / `soon` (≤ 5 días, amarillo) / `overdue` (vencida, rojo) / `none`. En Empresas cada tarjeta muestra el chip y "✓ Pago recibido" (mueve `dueDate` al mismo día del mes siguiente). En Notificaciones, sección "🧾 Mensualidades" con recordatorio de cobro (correo al contacto), pago recibido y suspender (si está vencida). Cuenta en el contador del menú.
- **Panel (Dashboard) = tablero del owner:** `GET /api/insights` (en `admin/server/api.ts`) calcula **pendientes para accionar** (avisos sin enviar, rendiciones que esperan al owner, mensualidades vencidas/por vencer, flujos sin payer, usuarios de pagos sin flujo, personas sin flujo, empresas sin flujos, rendiciones atascadas +3 días, aprobadas sin pagar +7 días, empresas sin fecha de facturación, personas que nunca ingresaron, cuentas sin empresa), cada una con severidad y botón "Resolver →" a su sección; **KPIs de uso** (activos 7/30 días con `lastSignInTime` de Auth, enviadas, tiempo promedio de aprobación y de pago); gráfico semanal (12 semanas, SVG propio con tooltip, una serie); uso por empresa, por persona y velocidad de aprobadores. UI en `admin/ui/src/pages/Insights.tsx`; debajo sigue el gasto por área/mes/categoría/trabajador.
- **Administrador de personal (`companyAdmin`, casilla que marca el owner):** en la web ve solo **Personas** y **Flujos** de su empresa (+ Pagos / Por aprobar si tiene esos roles). Crea cuentas con una **segunda instancia de Firebase** (`createAccount` en `web/src/firebase.ts`, no cierra su sesión; si falla el perfil, borra la cuenta), edita área/flujo/usuario de pagos/activo, envía enlace de clave (`sendPasswordResetEmail`). Edita flujos con el mismo editor de arriba-hacia-abajo; `saveFlow` (en `adminData.ts`) recalcula `isApprover`, asigna flujo a aprobadores sin flujo y, si cambia quién paga, actualiza `approverUids` de las rendiciones enviadas. Reglas: solo su empresa, no puede crear administradores ni cambiar `companyAdmin`/`companyId`, payer del flujo debe ser `paymentsUser` de la empresa, puede **leer** rendiciones de su empresa y solo cambiar `approverUids` dentro de los participantes del flujo. No gestiona áreas/categorías (las crea el owner).
- **Fotos de respaldo:** `companies/{cid}/reports/{rid}/attachments/{aid}` = `{name, caption, dataUrl (JPEG base64 ≤ ~450 KB), size, uploadedBy, createdAt}`. Plan Spark sin Storage → la web comprime cada foto (`compressImage` en `data.ts`, máx. 1600 px, calidad 0.8→0.5) y la guarda en el documento; máx. `MAX_ATTACHMENTS` = 10 por rendición. Se suben en el **mismo lote** que la rendición (`saveReport(..., {add, remove})`), así se pueden adjuntar al enviar. Las ven dueño, aprobadores, payer, admin. de personal y el owner (en el detalle del panel). Reglas: solo el dueño crea/borra mientras está editable; valida prefijo `data:image/jpeg;base64,` y tamaño. Al pasar a Blaze conviene moverlas a Firebase Storage.
- **Plantilla Excel:** fila 2 = ejemplo resuelto (amarillo, descripción empieza con `EJEMPLO`, se ignora al cargar), notas en los encabezados y mensajes de ayuda por celda; los gastos van desde la fila 3.
- **Trabajadores del flujo:** el editor de flujos (panel y web del admin. de personal) tiene la caja "👥 Trabajadores de este flujo" con selección múltiple; al guardar, los elegidos quedan con `flowId` = ese flujo (aunque estuvieran en otro) y quienes lo tenían y no están elegidos quedan sin flujo (`applyMembers` en el servidor, `saveFlow(..., members)` en la web). El esquema muestra sus nombres en el nodo inicial.
- **Inicio de la web:** aprobadores entran a `/aprobar` (primero en el menú); "Mis rendiciones" vive en `/mis-rendiciones` (`/` redirige según el rol).
- **Perfiles especiales** (`isSpecialProfile`: `paymentsUser` o `companyAdmin`): nunca están en un flujo como trabajadores ni aprobadores (no se les asigna `flowId`, no aparecen en los selectores ni en el esquema, el servidor rechaza un flujo que los tenga como aprobadores). El usuario de pagos solo aparece como "quién paga". El Panel alerta si algún flujo antiguo los tiene como aprobadores.
- **Indicador de carga:** `shared/Busy.tsx` → `useGlobalBusy(msg)` (reemplaza `useState(false)` de los estados busy y muestra el logo animado en el centro), `busy.run(msg, fn)`, `<BusyOverlay/>` montado en ambas apps (gris en el panel) y `<LogoLoader/>` en lugar de los textos "Cargando…".
- Con trabajadores elegidos explícitamente en un flujo, ya no se asigna automáticamente el flujo a sus aprobadores (eso hacía que no se pudiera quitar a un trabajador que también aprueba).
- **Links por empresa:** `https://cavedevz.com/rendify/<cid>/` (repo GitHub `tmontes30/rendify`; Vite base `/rendify/`; el build copia `index.html` a `404.html` para que GitHub Pages sirva cualquier subruta). `web/src/companyPath.ts` lee la empresa de la dirección; el ingreso muestra su nombre leyendo `publicCompanies/{cid}` (`{name}`, legible sin sesión con `get`, no se puede listar ni escribir; el panel lo sincroniza en `syncPublicCompanies`). Tras iniciar sesión, la dirección se reescribe al `cid` del usuario. Los correos del panel usan `${webUrl}${cid}/#/r/<id>`; las tarjetas de Empresas muestran y copian el link.
- **Flujo editado con rendiciones en curso:** al guardar un flujo (panel: `reroutePending`; web admin: en `saveFlow`) las rendiciones `pending` de ese flujo se reacomodan con `rerouteToFlow` (shared): parten en `startLevel` del dueño y saltan niveles ya aprobados en la ronda actual; si no queda nivel, esperan al owner. Reglas: el admin de personal solo puede dejar `currentLevel/currentApprovers` consistentes con el flujo vigente. El avance en la web muestra siempre `currentApprovers` y avisa si el flujo cambió sin reacomodar.
- **Tiempo real:** la web usa `onSnapshot` (`watchMyReports`, `watchPendingForMe`, `watchApproverHistory`, `watchPayments`, `watchReportChanges` en `data.ts`): Mis rendiciones, Por aprobar, Pagos, los contadores del menú y la rendición abierta se actualizan solos; el menú muestra un aviso (toast) cuando llega algo nuevo para aprobar o pagar. El panel del owner recarga cada sección al volver a la pestaña (`useLoad`) y revisa el contador de notificaciones cada 30 s.
- **Reenvíos:** `resubmissionInfo()` cuenta rechazos previos → "↻ 2° envío", aviso amarillo con quién rechazó y por qué; en "Por aprobar" se agrupan "Reenviadas con corrección" vs "Nuevas".
- **Notificaciones (sin envío automático):** el panel calcula avisos pendientes (`computeNotices` en `admin/server/api.ts`):
  1. Rendición `approved` sin aviso al payer posterior a la aprobación → avisar a quien paga.
  2. `pending` > `REMINDER_HOURS` (24 h) en el nivel actual, contadas desde que llegó al nivel (`max(submittedAt, decidedAt)`) o desde el último aviso de ese nivel → avisar al aprobador (si ya se avisó, "Recordatorio").
  3. `paid` en los últimos 30 días sin aviso posterior al pago → avisar al trabajador (mensaje con método, N° y fecha de pago).
  4. `pending` sin aprobadores → espera al owner.
  El owner copia/pega el correo (o "Abrir en mi correo") y pulsa "Marcar como avisado" (`lastNotice`).

## Seguridad (no romper)

- `firebase/firestore.rules` es la barrera real de la web: deny por defecto, aislamiento por empresa, validación de campos/tipos/largos, envío solo con los aprobadores exactos del flujo y el nivel de partida exacto (`expectedStart`, desenrollado hasta 8 niveles), aprobación solo por `currentApprovers`, historial `approvals` solo se puede **agregar** (slice; ojo: `list[0:0]` da error en reglas, por eso el caso vacío va aparte), usuario solo puede cambiar su `displayName`.
- Antes de cambiar reglas: editar → `npm run test:rules` (hoy 39 tests) → `npm run deploy:rules`. Agregar tests para cada caso nuevo.
- Si se agrega una moneda: `CURRENCIES` en shared **y** `currencies()` en las reglas.
- El panel owner escucha solo en `127.0.0.1`, exige `x-admin-token` (aleatorio por inicio, llega por `#t=` en la URL), valida Host/Origin y manda CSP. Todo lo privilegiado (usuarios, claims, flujos, catálogos, aprobación final, pagos, avisos) vive ahí.
- La web no tiene secretos (la config Firebase es pública por diseño).

### Limitaciones conocidas / próximos pasos sugeridos

- Plan Spark sin servidor: correos manuales; el avance de nivel lo decide el navegador del aprobador (un aprobador malicioso podría saltarse niveles superiores; un trabajador no). Solución: Firebase Functions (plan Blaze) para correos automáticos y avance en servidor.
- Pendiente recomendado: App Check (reCAPTCHA v3, secreto `VITE_RECAPTCHA_SITE_KEY` ya soportado), restringir la API key por dominio, 2FA en las cuentas Google/GitHub del owner.
- `approverNames` del flujo no se actualiza si un aprobador cambia su nombre en "Mi perfil" hasta que el owner vuelva a guardar el flujo.
- Sin respaldos automáticos (solo exportar CSV desde el panel).

## Convenciones de trabajo

- Al terminar cambios: `npx tsc -p admin/tsconfig.json`, `npx tsc -p web/tsconfig.json`, `npm run build -w web`; si tocan reglas, tests + deploy de reglas; commit en español con `Co-Authored-By`, push a `main` (publica la web) y reiniciar el panel.
- UI: barra lateral oscura con logo (azul en la web, gris en el panel), tarjetas, pestañas, badges por estado, modo oscuro vía tokens CSS. El logo lleva al inicio en ambas apps.
- El usuario no es técnico en detalle: explicar en simple, en español, y pedir confirmación antes de borrar datos o hacer cambios difíciles de revertir.
