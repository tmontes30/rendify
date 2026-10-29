# Rendición de gastos

Herramienta interna para que los trabajadores rindan gastos, los jefes de área los aprueben y el owner dé la aprobación final, marque pagos y vea reportes.

| Parte | Dónde corre | Quién la usa |
|---|---|---|
| `web/` | GitHub Pages (pública, con login) | Trabajadores y jefes de área |
| `admin/` | **Solo en el PC del owner** (`http://127.0.0.1:5050`) | Owner: usuarios, áreas, categorías, aprobación final, pagos, panel, CSV |
| `firebase/` | Reglas de seguridad de Firestore + tests | — |
| `shared/` | Tipos, monedas, estados y estilos comunes | — |

**Flujo:** Borrador → Enviada al jefe → Aprobada por jefe → Aprobada (owner) → Pagada. Cualquiera de los revisores puede *Rechazar* con comentario, y la rendición vuelve a ser editable por el trabajador.

## Seguridad: cómo está protegida

- **No hay registro público.** Solo el owner crea usuarios desde la app local. Si alguien crea una cuenta por su cuenta usando la API de Firebase, no tiene rol ni perfil y las reglas le niegan todo (además aparece en la lista de usuarios como "Sin perfil" para que la deshabilites).
- **Reglas de Firestore estrictas** ([firebase/firestore.rules](firebase/firestore.rules)): cada trabajador solo ve y edita sus rendiciones, y solo mientras están en borrador o rechazadas; el jefe solo ve su área y no puede aprobar las propias; nadie desde la web puede dar la aprobación final, marcar pagos, ni tocar usuarios, áreas o categorías. Se validan tipos, largos, monedas y montos enteros.
- **Desactivar a alguien corta el acceso al instante**: las reglas verifican en cada operación que el perfil esté activo y que el rol/área coincidan.
- **La clave de administrador (cuenta de servicio) nunca sale de tu PC**: no está en el repo ni en la web. La app local escucha solo en `127.0.0.1`, exige un token aleatorio nuevo en cada inicio y rechaza peticiones de otros sitios.
- **Montos verificados**: al aprobar, el owner recalcula los totales desde los gastos; si no coinciden con lo guardado, la app lo advierte.

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

Usuarios de prueba (contraseña `demo-12345`): `trabajador@demo.cl`, `jefe@demo.cl` (jefe de Ventas), `ops@demo.cl`.

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

Se abre el navegador con un enlace que contiene un token de sesión (cambia cada vez). Primero crea **áreas** y **categorías**, luego los **usuarios**. Al crear un usuario se genera una contraseña temporal que debes entregarle por un canal privado; también puedes generar un enlace para que la cree él mismo.

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
