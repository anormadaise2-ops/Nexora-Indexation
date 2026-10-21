# Nexora Indexation — logiciel de crawl et d'indexation

Application locale de type webmaster tools avec :
- ajout de propriétés de site ;
- vérification de contrôle par balise META, fichier `.well-known` ou DNS TXT ;
- découverte et vérification de sitemap XML ;
- crawler `NexoraBot` avec prise en compte basique de `robots.txt` ;
- extraction du titre, description, texte, URL canonique et liens internes ;
- liste des pages explorées et recherche dans l'index local ;
- sauvegarde persistante dans `data/db.json`.

## Prérequis

- Node.js 20 ou plus récent
- npm

## Installation et lancement

Dans le dossier du projet :

```bash
npm install
npm start
```

Puis ouvrir **http://localhost:3080** dans le navigateur.

Pour changer le port sous Windows PowerShell :

```powershell
$env:PORT=3090
npm start
```

## Vérification de propriété

### Balise META
Ajoutez dans le `<head>` de la page d'accueil la balise exacte fournie dans le tableau de bord, par exemple :

```html
<meta name="nexora-site-verification" content="JETON_AFFICHE_PAR_LE_TABLEAU_DE_BORD">
```

### Fichier
Créer `/.well-known/nexora-verification.txt` sur le site, avec le jeton exact comme contenu.

### DNS
Créer un enregistrement TXT nommé `_nexora-verification.votredomaine.fr` avec le jeton exact.

Après publication, cliquer sur **Vérifier la propriété**.

## Sitemap et exploration

1. Vérifiez la propriété.
2. Indiquez l'URL du sitemap, généralement `https://votredomaine.fr/sitemap.xml`.
3. Cliquez sur **Vérifier le sitemap**.
4. Cliquez sur **Lancer le crawler**.
5. Consultez les pages et utilisez « Tester la recherche ».

Le crawler est volontairement limité à 100 pages par exploration, avec une pause entre les requêtes. Il suit les pages HTML du même domaine vérifié et n'indexe pas automatiquement toutes les URL soumises : il doit pouvoir les explorer.

## Limites importantes

- Ce projet est un prototype fonctionnel pour développement local, pas un moteur de recherche mondial comparable à Google.
- Les données sont conservées dans un fichier JSON local. Pour un service public multi-utilisateur, il faut ajouter authentification, rôles, protections CSRF/rate limiting, une base PostgreSQL, une file de tâches et des journaux.
- Les règles `robots.txt` sont gérées de façon volontairement simple ; une implémentation de production doit prendre en charge complètement les groupes, jokers et règles `Allow`/`Disallow`.
- Le crawler bloque les hôtes privés/locales et revalide les redirections. Héberger un crawler public demande une revue de sécurité supplémentaire.
- Le serveur d'API est sans authentification et doit rester local ou derrière une authentification solide. Ne l'exposez pas directement à Internet.
- La recherche ne couvre que les pages que cette instance a explorées et indexées.
