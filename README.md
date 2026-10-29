# Rendición de gastos

Plataforma para que los trabajadores de **varias empresas** rindan gastos, pasen por **flujos de aprobación por niveles** y el owner gestione todo.

| Parte | Dónde corre | Quién la usa |
|---|---|---|
| `web/` | GitHub Pages (`https://cavedevz.com/Rendiciones-Empresas/`) | Trabajadores y aprobadores de cada empresa |
| `admin/` | **Solo en el PC del owner** (`npm run admin`) | Owner: empresas, usuarios, flujos, áreas, categorías, rendiciones, pagos, panel, CSV, avisos por correo |
| `firebase/` | Reglas de seguridad de Firestore + tests | — |
| `shared/` | Tipos, monedas, estados, logo y estilos comunes | — |

## Cómo funciona

- **Empresas:** cada empresa tiene sus propias áreas, categorías, flujos y usuarios. Los datos de una empresa no son visibles para otra.
- **Flujos de aprobación:** niveles en cadena (ej. Jefe directo → Gerente → Finanzas). Cada nivel tiene uno o más aprobadores (basta que apruebe uno) y, opcionalmente, un monto mínimo en la moneda base de la empresa para activarse. Si la rendición tiene gastos en otras monedas, los niveles con monto se activan siempre.
- **Usuarios:** a cada persona se le asigna empresa, área y flujo. Un aprobador es un usuario que figura en algún nivel de un flujo.
- **Estados:** Borrador → En aprobación (nivel 1, 2, …) → Aprobada → Pagada. Cualquier aprobador (o el owner) puede *Rechazar* con comentario y la rendición vuelve al trabajador para corregirla.
- **Para el trabajador:** “Nueva rendición” abre una sola pantalla con título y gastos, una casilla de confirmación y el botón “Enviar a aprobación”. También hay **carga masiva** con una plantilla Excel (.xlsx) que solo acepta su propio formato.
- **Avisos por correo:** desde el panel del owner, en cada rendición, “✉ Avisar por correo” arma el mensaje (destinatarios, asunto y texto) para copiar y pegar o abrir en tu correo.

## Seguridad: cómo está protegida

- **No hay registro público.** Solo el owner crea usuarios. Una cuenta creada por fuera no tiene empresa ni perfil, y las reglas le niegan todo.
- **Reglas de Firestore estrictas** ([firebase/firestore.rules](firebase/firestore.rules)): cada usuario solo ve su empresa; un trabajador solo ve y edita sus rendiciones (y solo en borrador o rechazadas); al enviar, los aprobadores deben ser exactamente los del flujo asignado; solo los aprobadores del nivel actual pueden aprobar, y nadie aprueba su propia rendición; el historial de aprobaciones no se puede borrar ni alterar; nadie desde la web marca pagos ni toca usuarios, flujos o catálogos.
- **Desactivar a alguien corta el acceso al instante.**
- **La clave de administrador nunca sale de tu PC.** El panel escucha solo en `127.0.0.1` con un token nuevo en cada inicio.
- **Montos:** los aprobadores y el owner ven los totales calculados desde los gastos; al aprobar o pagar, el owner recalcula los totales oficiales.
- **Limitación conocida (plan gratuito, sin servidor):** el aviso por correo es manual, y la decisión de qué nivel sigue la calcula el navegador del aprobador. Para automatizar correos y mover esa lógica a un servidor se puede pasar a Firebase Functions (plan Blaze).

## Requisitos (una vez)

1. **Node.js 20 LTS o superior**: <https://nodejs.org> (o `winget install OpenJS.NodeJS.LTS`).
2. **Java 11+** (solo para los emuladores/tests de Firebase): `winget install EclipseAdoptium.Temurin.21.JDK`.
3. Instala dependencias en la carpeta del proyecto:
   ```bash
   npm install
   ```
   > Consejo: OneDrive sincroniza `node_modules` (miles de archivos). Es mejor mover el proyecto a una carpeta fuera de OneDrive, p. ej. `C:\dev\rendiciones`.

## Probar todo en local (sin tocar Firebase real)

```bash
npm run emulators              # Terminal 1: emuladores Auth + Firestore (UI en http://127.0.0.1:4000)
npm run seed:emu -w admin      # Terminal 2: crea áreas, categorías y 3 usuarios de prueba
npm run admin:emu              # Terminal 2: app del owner contra el emulador (abre el navegador)
npm run dev:emu -w web         # Terminal 3: web en http://127.0.0.1:5173
```

Usuarios de prueba (contraseña `demo-12345`): `trabajador@demo.cl` (rinde), `jefe@demo.cl` (nivel 1) y `finanzas@demo.cl` (nivel 2, sobre $500.000), en “Empresa Demo”.

Tests de las reglas de seguridad:

```bash
npm run test:rules
```

## Puesta en producción

### 1. Firebase

1. Crea un proyecto en <https://console.firebase.google.com> (plan Spark gratuito es suficiente).
2. **Authentication** → Comenzar → habilita solo **Correo electrónico/contraseña**.
   - Configuración → *Dominios autorizados*: deja `localhost` y agrega `cavedevz.com` (tu dominio de GitHub Pages). Quita cualquier otro.
   - Configuración → *Política de contraseñas*: exige mínimo 10 caracteres.
   - Plantillas → ajusta el correo de "restablecer contraseña" en español.
3. **Firestore Database** → Crear base de datos → modo **producción** → región cercana (ej. `southamerica-west1` Santiago).
4. **Configuración del proyecto → Tus apps → Web (`</>`)**: registra una app y copia `apiKey`, `authDomain`, `projectId`, `appId`.
5. **Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**. Guarda el JSON **fuera del proyecto y fuera de OneDrive** (ej. `C:\secretos\rendiciones-admin.json`). Quien tenga este archivo controla toda la base de datos: no lo compartas ni lo subas a ningún lado.
6. Edita [.firebaserc](.firebaserc) con tu ID de proyecto y publica reglas e índices:
   ```bash
   npx firebase login
   npm run deploy:rules
   ```

### 2. App del owner (tu PC)

```bash
copy admin\config.example.json admin\config.local.json   # y pon la ruta del JSON del paso 5
npm run admin
```

Se abre el navegador con un enlace que contiene un token de sesión (cambia cada vez). Orden recomendado: **Empresas** → elige la empresa → **Áreas y categorías** → **Usuarios** (incluidos los aprobadores) → **Flujos de aprobación** → vuelve a **Usuarios** y asigna el flujo a cada uno. Al crear un usuario se genera una contraseña temporal que debes entregarle por un canal privado; también puedes generar un enlace para que la cree él mismo.

### 3. Web en GitHub Pages

1. Crea un repositorio en GitHub (puede ser privado si tienes plan que lo permita con Pages; si es público no hay problema: no contiene secretos).
2. Sube el código (incluye `package-lock.json`, generado por `npm install`):
   ```bash
   git init && git add . && git commit -m "Inicio" && git branch -M main
   git remote add origin https://github.com/TU_USUARIO/TU_REPO.git && git push -u origin main
   ```
3. En el repo: **Settings → Secrets and variables → Actions** → crea los secretos `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (y opcional `VITE_RECAPTCHA_SITE_KEY`).
4. **Settings → Pages → Source: GitHub Actions**.
5. Cada push a `main` publica la web en `https://cavedevz.com/Rendiciones-Empresas/`. Ese es el link que compartes.

### 4. Endurecimiento recomendado

- **Restringe la API key**: Google Cloud Console → APIs y servicios → Credenciales → la clave "Browser key" → *Restricciones de aplicaciones: Sitios web* → `https://cavedevz.com/*` y `http://127.0.0.1:5173/*`.
- **App Check** (bloquea clientes que no sean tu web): Firebase Console → App Check → registra la app web con reCAPTCHA v3, pon la *site key* en el secreto `VITE_RECAPTCHA_SITE_KEY`, y cuando veas tráfico verificado activa *Aplicar* para Firestore y Authentication.
- **Alertas de presupuesto**: aunque estés en el plan gratuito, revisa periódicamente *Uso y facturación*.
- **Respaldo**: exporta CSV desde el panel periódicamente.

## Mantenimiento

- **Agregar una moneda**: añádela en `CURRENCIES` de [shared/src/index.ts](shared/src/index.ts) **y** en `currencies()` de [firebase/firestore.rules](firebase/firestore.rules); luego `npm run deploy:rules` y push.
- **Cambiar reglas**: edita, corre `npm run test:rules` y luego `npm run deploy:rules`.
- **Un trabajador deja la empresa**: Usuarios → Deshabilitar. Sus rendiciones quedan para el historial.
