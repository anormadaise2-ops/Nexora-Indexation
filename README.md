# Nexora Indexation — interface complète et serveur local persistant

Interface d'accueil moderne personnalisable (thèmes clair/sombre, cinq accents), recherche dans les pages déjà indexées, soumission de propriétés, tableau de bord webmaster, vérification de propriété, sitemap XML, crawler NexoraBot et index local JSON persistant.

## Lancer manuellement

Prérequis : Node.js 20 ou supérieur.

```powershell
npm install
npm start
```

Ouvrir `http://127.0.0.1:3080` ou le tableau de bord `http://127.0.0.1:3080/dashboard.html`.

## Démarrage persistant sous Windows

Lancer `Install-Nexora.ps1` du paquet complet. Le script copie les fichiers du projet vers `%USERPROFILE%\Downloads\NexoraIndexation\NexoraIndexation`, sauvegarde les principaux anciens fichiers, installe les dépendances et crée une tâche planifiée qui lance le serveur à chaque ouverture de session. Le superviseur redémarre Node si le serveur s'arrête.

Le serveur écoute par défaut sur `127.0.0.1` pour ne pas exposer sans authentification le panneau webmaster et le crawler sur Internet. Les données se trouvent dans `data/db.json` et les journaux dans `logs/server.log`; ces dossiers ne doivent pas être publiés dans Git.

## Fonctionnement

1. Ouvrir la page d'accueil et soumettre une URL publique.
2. Copier le jeton META fourni dans le `<head>` du site à vérifier.
3. Ouvrir « Espace Webmaster », vérifier la propriété, fournir un sitemap XML puis lancer le crawler.
4. Rechercher dans les pages indexées depuis la page d'accueil.

Le crawler n'explore que les pages publiques autorisées et vérifiées. La recherche porte uniquement sur les pages explorées par cette instance ; ce n'est pas encore un index mondial comparable à Google. Les modes images et actualités sont affichés mais désactivés.

## Important à propos de la disponibilité

Cette configuration maintient le serveur actif sur ce PC tant que Windows est démarré et que la session utilisateur est ouverte. Elle ne transforme pas le PC en hébergement Internet permanent : l'appareil doit rester allumé et connecté. Pour un service public 24/7, hébergez Node.js sur un serveur ou une plateforme adaptée et ajoutez une authentification solide avant d'exposer l'API.
