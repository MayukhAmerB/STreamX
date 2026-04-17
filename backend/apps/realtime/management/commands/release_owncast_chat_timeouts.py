from django.core.management.base import BaseCommand, CommandError

from apps.realtime.services import (
    OwncastAdminError,
    OwncastConfigError,
    release_expired_owncast_chat_timeouts,
)


class Command(BaseCommand):
    help = "Release expired StreamX-managed Owncast chat timeouts."

    def add_arguments(self, parser):
        parser.add_argument(
            "--timeout",
            type=int,
            default=8,
            help="Owncast admin API timeout in seconds.",
        )

    def handle(self, *args, **options):
        try:
            result = release_expired_owncast_chat_timeouts(timeout=options["timeout"])
        except (OwncastConfigError, OwncastAdminError) as exc:
            raise CommandError(str(exc)) from exc

        if result["errors"]:
            self.stdout.write(
                self.style.WARNING(
                    "Owncast timeout release completed with errors: "
                    f"{result['released']} released, {len(result['errors'])} failed, "
                    f"{result['checked']} checked."
                )
            )
            return

        self.stdout.write(
            self.style.SUCCESS(
                "Owncast timeout release complete: "
                f"{result['released']} released, {result['checked']} checked."
            )
        )
