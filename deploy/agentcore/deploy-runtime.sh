#!/usr/bin/env bash
# Deploy (create or update) the ID-JAG kit's whoami AgentCore Runtime: us-east-2, account
# 265988230536, CodeZip packaging from s3://agentcore-code-265988230536-us-east-2/idjag_whoami/code.zip.
#
# IAM note: creating the execution role is a human action (bedrock-agentcore skill rule).
# deploy/agentcore/trust-policy.json + runtime-policy.json hold exactly what the role needs;
# if it does not exist yet this script says so and exits, printing the two commands to run.
#
# Prereqs: AWS_PROFILE=agent-toolkit; the code zip already uploaded (the script uploads it
# if agentcore-runtime/agent.py exists and --upload is passed).
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-2 AWS_REGION=us-east-2
PROFILE="${AWS_PROFILE:-agent-toolkit}"
ACCOUNT=265988230536
REGION=us-east-2
NAME="idjag_whoami"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/AmazonBedrockAgentCore-idjag_whoami"
BUCKET="agentcore-code-${ACCOUNT}-${REGION}"
# The issuer whose JWTs the runtime accepts. Until the resource-as has its own DNS name
# (AgentCore rejects a path-ful discovery document), the runtime validates PingFederate's
# ID-JAGs directly: same discovery, allowedClients = the ID-JAG's client_id claim.
DISCOVERY_URL="https://<pf-host>.ping-demo.example.invalid/.well-known/openid-configuration"
ALLOWED_CLIENTS="id-jag-playground"
ZIP_FILE="${1:-}"

aws_arg() { echo "--profile $PROFILE"; }

if [ -n "$ZIP_FILE" ]; then
  echo "Uploading $ZIP_FILE to s3://$BUCKET/$NAME/code.zip"
  aws $(aws_arg) s3 cp "$ZIP_FILE" "s3://$BUCKET/$NAME/code.zip"
fi

# The role must exist before create/update (PassRole).
if ! aws $(aws_arg) iam get-role --role-name "AmazonBedrockAgentCore-idjag_whoami" >/dev/null 2>&1; then
  echo "Execution role AmazonBedrockAgentCore-idjag_whoami does not exist."
  echo "Human steps (in your own terminal, with admin credentials):"
  echo "  aws iam create-role --role-name AmazonBedrockAgentCore-idjag_whoami \\"
  echo "    --assume-role-policy-document file://deploy/agentcore/trust-policy.json"
  echo "  aws iam put-role-policy --role-name AmazonBedrockAgentCore-idjag_whoami \\"
  echo "    --policy-name runtime --policy-document file://deploy/agentcore/runtime-policy.json"
  exit 1
fi

set +e
aws $(aws_arg) bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$NAME" --region "$REGION" >/dev/null 2>&1
EXISTS=$?
set -e

# The body is identical for create and update except update also requires networkConfiguration
# (gotcha 28: always include it).
BODY=$(cat <<EOF
{
  "roleArn": "$ROLE_ARN",
  "agentRuntimeArtifact": {
    "codeConfiguration": {
      "code": { "s3": { "bucket": "$BUCKET", "prefix": "$NAME/code.zip" } },
      "runtime": "PYTHON_3_12",
      "entryPoint": ["agent.py"]
    }
  },
  "networkConfiguration": { "networkMode": "PUBLIC" },
  "protocolConfiguration": { "serverProtocol": "HTTP" },
  "authorizerConfiguration": {
    "customJWTAuthorizer": {
      "discoveryUrl": "$DISCOVERY_URL",
      "allowedClients": ["$ALLOWED_CLIENTS"]
    }
  },
  "requestHeaderConfiguration": { "requestHeaderAllowlist": ["Authorization"] },
  "description": "ID-JAG kit whoami — answers with the decoded identity the ID-JAG chain delivered"
}
EOF
)

if [ "$EXISTS" = 0 ]; then
  echo "Updating existing runtime $NAME"
  aws $(aws_arg) bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$NAME" --region "$REGION" --cli-input-json "$BODY"
else
  echo "Creating runtime $NAME"
  aws $(aws_arg) bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "$NAME" --region "$REGION" --cli-input-json "$BODY"
fi
