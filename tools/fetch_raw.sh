#!/usr/bin/env sh
# Download the raw open datasets used by `npm run prepare-data` into tools/raw/.
set -e
mkdir -p tools/raw
curl -fsSL -o tools/raw/population.csv   https://raw.githubusercontent.com/datasets/population/main/data/population.csv
curl -fsSL -o tools/raw/gdp.csv          https://raw.githubusercontent.com/datasets/gdp/main/data/gdp.csv
curl -fsSL -o tools/raw/country-codes.csv https://raw.githubusercontent.com/datasets/country-codes/main/data/country-codes.csv
curl -fsSL -o tools/raw/storms.csv       https://raw.githubusercontent.com/tidyverse/dplyr/main/data-raw/storms.csv
echo "raw data in tools/raw/"
