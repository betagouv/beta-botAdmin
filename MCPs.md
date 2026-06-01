# beta.gouv.fr MCP servers

MCP servers to exploit our organisation data.

The goal is to be able to query about teams, members, thematic or technical stack in natural french language.

## Example queries :

- Qui est dans l'équipe XXX ?
- Quels produits travaillent sur le thème de l'éducation ?
- que fait Julien Boudeau ?
- Qui travaille dans l'incubateur de la santé ?
- Quels sont les nouveaux produits créés ?
- Quelles startups sont en accélération ?
- Quelles startups ont le plus de développeurs ?
- Dans quelle phase est la startup recosanté ?
- Qui sait faire du PostgreSQL ?
- Qui contacter pour de l'aide sur metabase ?

## MCP Features

### Community

- Find community members by name, skills, team name
- Find product teams by name, thematic, incubator, technical stack

sources: API

### Code

Find GitHub repositories by name, thematic, incubator, technical stack.

Use GitHub MCP when not enough.

sources: gitscan

### News

Get organisations news from all sources

### Docs

Get informations about all our internal processes from doc.incubateur.net.

Topics are covered in its `SUMMARY.md`

## Data sources

### `./data/api`

Store our API data about members and startups which are also the product and team name.

- `members.json`: all about members, skills and their missions
- `startups.json`: all about startups products teams. each team has a repository attribute that point to a GIT repo
- `startups_details.json`: all about startups (teams) members

### `./data/gitscan`

This folder store fresh data for all our repositories in `repos/[ORG]/[REPO]`.

- `commits.txt`: latests commits
- `overwiew.json`: repo description from this schema: https://github.com/betagouv/gitscan/blob/main/schemas/repository.schema.json
- `CHANGELOG-generated.md`: latest LLM generated changelog of the repo

### `./data/doc.incubateur.net`

This folder stores our documentation GIT repo.

The documentation topics are defined in `SUMMARY.md`

### `./data/beta.gouv.fr`

This folder stores our website and product descriptions GIT repo.

The `content/_startups` folder holds all GIT changes to the products description and metadata.

### `./data/peertube`

Latest channels videos feeds.

### `./data/calendar.ics`

Our community public calendar.

### `./data/index`

An index of all active members and startups the user can query. use it like a NER to detect some eventual known items in the user query.

- `startups.json`: index of all active startups
- `members.json`: index of all active members
- `phases.txt`: index of startups possible phases and their description
