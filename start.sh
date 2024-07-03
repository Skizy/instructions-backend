#!/bin/bash

/home/skizy/bin/mongo_start.sh

PWD=/home/skizy/coding/web/instructions_monorepo/apps/backend bun run dev
