from django.core.management.base import BaseCommand, CommandError

from apps.realtime.services import (
    OwncastAdminError,
    OwncastConfigError,
    sync_owncast_chat_identities_from_recent_messages,
)


class Command(BaseCommand):
    help = "Sync mapped Owncast chat display names from recent Owncast chat messages."

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit",
            type=int,
            default=1000,
            help="Maximum recent Owncast chat messages to scan.",
        )
        parser.add_argument(
            "--timeout",
            type=int,
            default=8,
            help="Owncast admin API timeout in seconds.",
        )

    def handle(self, *args, **options):
        try:
            result = sync_owncast_chat_identities_from_recent_messages(
                limit=options["limit"],
                timeout=options["timeout"],
            )
        except (OwncastConfigError, OwncastAdminError) as exc:
            raise CommandError(str(exc)) from exc

        self.stdout.write(
            self.style.SUCCESS(
                "Owncast handle sync complete: "
                f"{result['updated_identities']} updated, "
                f"{result['matched_identities']} matched, "
                f"{result['scanned_users']} Owncast users scanned."
            )
        )
