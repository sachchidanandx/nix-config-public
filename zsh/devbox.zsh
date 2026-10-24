# --- begin: webui ---

export COMMIT_MAKE_TARGETS=unit
export NS_GIT_HOME=$HOME/src/ui
export NS_BUILD_DIR=$HOME/src/ui/service
export NS_WEB_UI_DIR=$HOME/src/ui/webui
export NS_SQL_DATA=$HOME/src/ui/sql/data
export NS_DOCKER_NETWORK=webui-devbox
export NS_DOCKER_SUBNET=172.19.0.0/16
export QUALIFY_MAKE_TARGETS=pkg-qualify
export UNIT_TEST_ENV=unit_testing_without_db

# --- end: webui ---

# --- begin: webui-devbox ---

export NS_GIT_CPUS=4
export PDFSCHEDULER_VERSION=latest
export IMAGE_TAG=develop
export XDEBUG_MODE=off
export XDEBUG_SESSION='VSCODE'
export XDEBUG_CONFIG='start_with_request=yes client_port=10000 client_host=10.254.254.254'

# --- end: webui-devbox ---
