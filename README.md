# Sillage · Assistant de support en temps réel

Sillage répond aux questions de livraison, de retour et de facturation, consulte l’état des commandes associées à la session et transmet la conversation à un conseiller avec l’accord du client. L’application inclut une interface client et une file opérateur protégée.

## Démarrage

Prérequis : Node.js 24 ou version ultérieure. Aucune dépendance à installer.

```sh
npm start
```

1. Ouvrez [le chat](http://127.0.0.1:3000). Cliquez sur **Suivre une commande**, sélectionnez une référence dans le panneau latéral, puis demandez « Et elle arrive quand ? ».
2. Cliquez sur **Parler à un conseiller**, puis confirmez le partage de la conversation.
3. Ouvrez [l’espace opérateur](http://127.0.0.1:3000/operator) dans un deuxième onglet et saisissez le jeton affiché dans le terminal.
4. Ouvrez le dossier, répondez et vérifiez que le message apparaît dans le chat client. Clôturez le dossier pour rendre la main à l’assistant.

Les commandes et les politiques commerciales sont fictives.

## Fonctionnement

| Fonction | Implémentation |
| --- | --- |
| Réponses rapides | Le serveur trouve l’intention courante et répond localement. Les réponses du conseiller déclenchent une mise à jour du chat via Server-Sent Events. La file opérateur se rafraîchit toutes les 2,5 secondes. |
| Outils | L’assistant consulte le catalogue de politiques et effectue une recherche de commande en lecture seule, limitée à la session courante. |
| Mémoire | SQLite conserve les messages, le dernier numéro de commande consulté, l’attente d’une référence et l’état du dossier. L’historique expire après sept jours d’inactivité. |
| Reprise humaine | Le client confirme le partage, puis le dossier apparaît dans la file. L’assistant se met en pause pendant la reprise. Le premier message de l’opérateur fait passer le dossier en conversation. |
| Garde-fous | Cookie de session HttpOnly/SameSite, jeton opérateur, contrôle d’origine sur les écritures et limites de taille et de fréquence. Le serveur bloque les formats courants de données sensibles, notamment les numéros de carte et les identifiants secrets explicites. Les annulations, modifications et remboursements sont orientés vers un conseiller. |

## Configuration

Le serveur lit un fichier `.env` s’il existe. Les options sont documentées dans [`.env.example`](.env.example).

- Sans clé API, l’assistant traite les parcours intégrés localement.
- Avec `OPENAI_API_KEY`, le texte d’une question que les règles locales n’ont pas classée peut être envoyé à OpenAI pour sélectionner un thème parmi les politiques publiques. Les références, les textes contenant des chiffres ou un signe `@`, l’historique et les résultats des outils restent locaux. Le modèle renvoie un thème validé côté serveur. Les réponses proviennent du catalogue local et le modèle ne dispose d’aucun outil. Le délai maximal côté API est de 1,8 seconde. [Format utilisé pour la classification](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
- En mode `NODE_ENV=production`, définissez un `OPERATOR_TOKEN` aléatoire d’au moins 32 caractères et servez l’application en HTTPS pour activer le cookie sécurisé. Le serveur écoute sur `127.0.0.1:3000` par défaut. Avec un proxy, conservez l’en-tête `Host` d’origine et désactivez la mise en mémoire tampon de `/api/events`. La limite de création de sessions utilise l’adresse IP de la connexion au serveur.
- Utilisez un seul processus Node et un volume persistant pour le fichier SQLite (`data/support.sqlite` par défaut, configurable avec `SUPPORT_DB`). Le jeton opérateur est partagé entre les membres de l’équipe habilités.

## Vérification

```sh
npm test
```

Le workflow GitHub Actions exécute les tests d’intégration à chaque push et pull request. Ils couvrent l’isolation des commandes, la validation des entrées, la reprise humaine en direct et la persistance après redémarrage.
