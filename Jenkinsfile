// ════════════════════════════════════════════════════════════════════════════
// Prio — Jenkins pipeline (Organization Folder)
// ════════════════════════════════════════════════════════════════════════════
// Every branch, every push: checkout → build the docker compose images.
// That's the whole pipeline for feature branches — a compile/build gate,
// nothing is started.
//
// main (or master) only: also deploy — generate a real .env from Jenkins
// credentials, bring the production stack (docker-compose.prod.yml, no
// mailpit) up on this host, and verify every service reports healthy.
// No preview environments, no per-branch deploys: main is the single,
// always-on deployment at https://prio.symbiosystech.in.
//
// Migrations run automatically as part of `docker compose up` — the
// `migrate` service applies pending Prisma migrations and exits, and `app`
// will not start until it has completed successfully. There's no separate
// migration stage here. Seeding is a deliberate one-off (see README), not
// run by this pipeline.
// ════════════════════════════════════════════════════════════════════════════

pipeline {
    agent any

    options {
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 20, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    environment {
        DOCKER_BUILDKIT          = '1'
        COMPOSE_DOCKER_CLI_BUILD = '1'
        COMPOSE_FILE             = 'docker-compose.prod.yml'
    }

    stages {

        // ─────────────────────────────────────────────────────────────────────
        stage('Checkout') {
            steps {
                echo "Checking out ${env.BRANCH_NAME} (${env.GIT_COMMIT})..."
                checkout scm
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        stage('Environment Check') {
            steps {
                sh '''
                    docker --version
                    docker compose version
                '''
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        stage('Classify Build') {
            steps {
                script {
                    env.IS_MAIN = (env.BRANCH_NAME == 'main' || env.BRANCH_NAME == 'master') ? 'true' : 'false'
                    echo 'Branch: ' + env.BRANCH_NAME
                    echo 'Mode:   ' + (env.IS_MAIN == 'true' ? 'BUILD + DEPLOY' : 'BUILD ONLY')
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // `docker compose build` still has to interpolate the whole file,
        // including `app`'s required AUTH_SECRET/SMTP_HOST/SMTP_PORT — and
        // `.env` doesn't exist yet on non-main branches (Generate Deploy Env
        // below is main-only). These placeholders satisfy that interpolation
        // only; nothing at build time actually reads them. Same reasoning as
        // the Dockerfile's own placeholder DATABASE_URL for `prisma generate`
        // / `next build`. On main, Deploy rebuilds again with the real .env.
        // ─────────────────────────────────────────────────────────────────────
        stage('Build Images') {
            steps {
                sh '''
                    AUTH_SECRET=build-placeholder \
                    SMTP_HOST=build-placeholder \
                    SMTP_PORT=25 \
                    docker compose build
                '''
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // main only, from here down.
        //
        // .env is gitignored (real secrets live there). Generate it from
        // Jenkins credentials before bringing the stack up.
        //
        // BASE_URL / POSTGRES_USER / POSTGRES_DB / SMTP_HOST / SMTP_PORT /
        // SMTP_USERNAME / SMTP_FROM / SMTP_SECURE aren't secrets, so they're
        // hardcoded below instead of pulled from credentials. Only
        // SMTP_PASSWORD is.
        //
        // No SEED_* vars: prisma/seed.ts is a deliberate one-off run by hand
        // (see README), never invoked by this pipeline, so there is nothing
        // here that reads them.
        // ─────────────────────────────────────────────────────────────────────
        stage('Generate Deploy Env') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([
                    string(credentialsId: 'prio-postgres-password',    variable: 'S_POSTGRES_PASSWORD'),
                    string(credentialsId: 'prio-auth-secret',          variable: 'S_AUTH_SECRET'),
                    string(credentialsId: 'prio-smtp-password',        variable: 'S_SMTP_PASSWORD'),
                ]) {
                    sh '''
                        set +x
                        {
                            echo "POSTGRES_USER=prio"
                            echo "POSTGRES_PASSWORD=${S_POSTGRES_PASSWORD}"
                            echo "POSTGRES_DB=prio"
                            echo "AUTH_SECRET=${S_AUTH_SECRET}"
                            echo "BASE_URL=https://prio.symbiosystech.in"
                            echo "SMTP_HOST=webmail.symbiosystech.com"
                            echo "SMTP_PORT=587"
                            echo "SMTP_USERNAME=prio@symbiosystech.com"
                            echo "SMTP_PASSWORD=${S_SMTP_PASSWORD}"
                            echo "SMTP_FROM=Prio <prio@symbiosystech.com>"
                            echo "SMTP_SECURE=false"
                        } > .env
                    '''
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // `app` declares `depends_on: migrate: condition: service_completed_
        // successfully`, so this call already blocks app startup until
        // migrations have applied cleanly.
        // ─────────────────────────────────────────────────────────────────────
        stage('Deploy') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                sh 'docker compose up -d --build --remove-orphans'
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        stage('Verify Deployment') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                sh '''
                    NAMES="prio-postgres prio-redis prio-app"
                    for i in $(seq 1 30); do
                        all_healthy=true
                        for name in $NAMES; do
                            health=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
                            if [ "$health" != "healthy" ]; then
                                all_healthy=false
                            fi
                        done
                        if [ "$all_healthy" = "true" ]; then
                            echo "All services healthy"
                            exit 0
                        fi
                        echo "Waiting for services to become healthy (attempt ${i}/30)..."
                        sleep 3
                    done
                    echo "Services did not become healthy in time"
                    docker compose ps
                    for name in $NAMES; do
                        echo "-- logs: ${name} --"
                        docker logs "$name" --tail=30 2>&1 || true
                    done
                    exit 1
                '''
            }
        }
    }

    post {
        success {
            script {
                if (env.IS_MAIN == 'true') {
                    echo "Build ${env.BUILD_NUMBER} on ${env.BRANCH_NAME} — deployed and healthy."
                } else {
                    echo "Build ${env.BUILD_NUMBER} on ${env.BRANCH_NAME} — images build cleanly."
                }
            }
        }
        failure {
            echo 'Build failed — see logs above.'
            script {
                if (env.IS_MAIN == 'true') {
                    sh 'docker compose logs --tail=50 || true'
                }
            }
        }
        always {
            sh 'rm -f .env || true'
            // Every build re-builds the same image tags (no per-build
            // versioning), so the previous build's images become dangling
            // (<none>:<none>) the moment the new ones are tagged. Prune
            // those — this only removes untagged images with no container
            // (running or stopped) using them, so it can never touch what
            // Deploy just brought up.
            sh 'docker image prune -f || true'
        }
    }
}
