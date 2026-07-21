import { config } from "../config.js";

export function buildHelp(): string {
  return buildBotHelp();
}

// OPS-request help, shown by `/help` inside the rooms listed in
// MATRIX_OPS_ROOMS. Content mirrors demandes-ops.md (the espace-membre form).
// Open to everyone, no command-room restriction.
export function buildOpsHelp(): string {
  return `# Faire une demande d'OPS

Les demandes d'OPS passent par un **formulaire dans l'espace membre** (il remplace l'ancien form Airtable). La demande est enregistrée et traitée par l'équipe ops.

## Comment faire

1. Va sur **Services** dans l'[espace membre](https://espace-membre.beta.gouv.fr).
2. Clique sur la carte **Demandes d'OPS**.
3. Choisis le **type de demande**.
4. Remplis les champs qui apparaissent (ils dépendent du type).
5. Si ce n'est pas pour une startup d'État, précise le **projet**.
6. **Envoie**.

Ton identifiant Tchap, ton email et ton nom sont préremplis automatiquement.

## Ce que tu peux demander

| Type de demande | Champs à remplir |
|---|---|
| Création d'app Scalingo | Nom de l'app, Email collaborateur |
| Ressources Clever cloud / OVH / scaleway | Commentaires *(obligatoire)* |
| Création/délégation domaine/zone DNS (OVH) | Handle OVH, Zone DNS |
| Ajouter un record sur domaine OVH (CNAME, A...) | Commentaires *(obligatoire)* |
| Ajout site/membre Matomo | URL du site, Email à associer |
| Ajout team/membre Sentry | URL du site, Email à associer |
| Ajout site sur updown.io | URL à surveiller, Emails à notifier |
| Création compte Tally | Commentaires *(obligatoire)* |
| Mon email bounce | Commentaires *(obligatoire)* |
| Autre | Commentaires |

Chaque type a aussi un champ **Commentaires** (libre).

> Si ton type de demande n'est pas dans la liste : pose la question directement ici, sur le canal \`~Demandes-OPS\`.`;
}

function buildBotHelp(): string {
  const cmdRooms = config.matrix.commandRooms;
  const cmdWhere = config.matrix.commandRoomsLabel
    ? config.matrix.commandRoomsUrl
      ? `[${config.matrix.commandRoomsLabel}](${config.matrix.commandRoomsUrl})`
      : `\`${config.matrix.commandRoomsLabel}\``
    : cmdRooms.length > 0
      ? cmdRooms.map((r) => `\`${r}\``).join(", ")
      : "(aucune restriction, partout)";

  return `# Aide betabot

Je suis un bot **à commandes** : je ne discute pas en langage naturel.

Dans ${cmdWhere}, **mentionne-moi suivi d'une commande**, par exemple \`@betabot /help\`.

## Commandes

Une commande **de base** par ligne (la plus courante). Toutes les variantes et options sont dans la carte \`… help\` correspondante.

| Commande de base | Ce qu'elle fait | Tout le reste |
|---|---|---|
| \`@betabot /help\` | Affiche cette aide | — |
| \`@betabot /emails join <liste> <email>\` | Ajoute quelqu'un à une mailing list | \`@betabot /emails help\` |
| \`@betabot /salon create <nom>\` | Crée un salon dans l'espace géré | \`@betabot /salon help\` |
| \`@betabot /espace create <nom>\` | Crée un sous-espace | \`@betabot /espace help\` |
| \`@betabot /invite <startup>\` | Invite une startup dans le salon où tu tapes | \`@betabot /invite help\` |

> ⚠️ Un texte sans commande ne renvoie qu'un message générique, et sans \`@\` ni \`/\` dans un salon je reste silencieux.

## Si quelque chose ne marche pas

- Commande refusée dans un salon → utilise-la dans ${cmdWhere}
- Réponse "permission denied" sur \`/emails\` → mon compte DiMail n'a pas les droits, contacte l'admin
- Pas de réaction du tout → vérifie que ton message commence par \`/\` (en salon, \`@mentionne\`-moi)`;
}
