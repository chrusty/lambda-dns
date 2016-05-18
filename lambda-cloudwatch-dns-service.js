var AWS = require('aws-sdk');
var async = require('async');
var ROLE_TAG = 'role';
var ROUTE53_DOMAIN_NAME_TAG = 'r53-domain-name';
var ROUTE53_ZONE_ID_TAG = 'r53-zone-id';
var TTL_SECONDS = 300;

// Handler:
exports.handler = function (message, context) {
    // Log the raw "event":
    // console.log(JSON.stringify(message));
    var cloudWatchMessage = JSON.parse(JSON.stringify(message));

    // Log the config:
    console.log('R53 Domain-name tag: "' + ROUTE53_DOMAIN_NAME_TAG + '"');
    console.log('R53 Hosted-zone ID tag: "' + ROUTE53_ZONE_ID_TAG + '"');
    console.log('Role tag: "' + ROLE_TAG + '"');
    console.log('TTL: "' + TTL_SECONDS + '"');
    console.log('Region: "' + cloudWatchMessage['region'] + '"')
    console.log('AZ: "' + cloudWatchMessage['detail']['Details']['Availability Zone'] + '"')
    console.log('Autoscaling Group: "' + cloudWatchMessage['detail']['AutoScalingGroupName'] + '"')
    console.log('Autoscaling Event: "' + cloudWatchMessage['detail-type'] + '"')

    // Run if we're processing a launch or terminate event:
    if (cloudWatchMessage['detail-type'] === "EC2 Instance Launch Successful" || cloudWatchMessage['detail-type'] === "EC2 Instance Terminate Successful") {
        console.log("Handling " + cloudWatchMessage['detail-type'] + " Event for " + cloudWatchMessage['detail']['AutoScalingGroupName']);

        async.waterfall(
            [
                // Get details about the autoscaling-group (instances, tags etc):
                function describeAutoscalingGroup(next) {
                    console.log("* Retrieving ASG details ...");
                    var autoscaling = new AWS.AutoScaling({region: cloudWatchMessage['region']});

                    // Look up the autoscaling group:
                    autoscaling.describeAutoScalingGroups(
                        {
                            AutoScalingGroupNames: [cloudWatchMessage['detail']['AutoScalingGroupName']],
                            MaxRecords: 1
                        }, function(err, response) {
                            if (response.AutoScalingGroups.length == 0) {
                                next('Unable to find autoscaling group "' + cloudWatchMessage['detail']['AutoScalingGroupName'] + '"!')
                            } else {
                                next(err, response.AutoScalingGroups[0]);
                            }
                        }
                    );
                },
                // Make sure we got a role-tag:
                function processTags(autoScalingGroup, next) {
                    // console.log(autoScalingGroup)
                    console.log("* Processing ASG tags ...");
                    var route53MetaData = {};

                    // Search for our role-tag in the ASGs list of tags:
                    for (tag of autoScalingGroup.Tags) { 
                        if (tag.Key == ROLE_TAG) {
                            route53MetaData.role = tag.Value;
                            console.log('  => Role-name: "' + route53MetaData.role + '"');
                        } else if (tag.Key == ROUTE53_DOMAIN_NAME_TAG) {
                            route53MetaData.domainName = tag.Value;
                            console.log('  => R53 domain-name: "' + route53MetaData.domainName + '"');
                        } else if (tag.Key == ROUTE53_ZONE_ID_TAG) {
                            route53MetaData.zoneId = tag.Value;
                            console.log('  => R53 zone-ID: "' + route53MetaData.zoneId + '"');
                        }
                    }

                    // Make sure we found one:
                    if (route53MetaData.role == "") {
                        next('ASG: ' + cloudWatchMessage['detail']['AutoScalingGroupName'] + ' does not define a "' + ROLE_TAG + '" tag!');
                    } else if (route53MetaData.domainName == "") {
                        next('ASG: ' + cloudWatchMessage['detail']['AutoScalingGroupName'] + ' does not define a "' + ROUTE53_DOMAIN_NAME_TAG + '" tag!');
                    } else if (route53MetaData.zoneId == "") {
                        next('ASG: ' + cloudWatchMessage['detail']['AutoScalingGroupName'] + ' does not define a "' + ROUTE53_ZONE_ID_TAG + '" tag!');
                    }

                    next(null, route53MetaData, autoScalingGroup);
                },
                // Build a list of running instances:
                function retrieveRunningInstanceIds(route53MetaData, autoScalingGroup, next) {
                    // console.log(autoScalingGroup)
                    console.log("* Finding running instances ...");
                    var instanceIds = [];

                    // Find instances which are running:
                    for (instance of autoScalingGroup.Instances) { 
                        if (instance.LifecycleState == "InService") {
                            instanceIds.push(instance.InstanceId);
                        }
                    }

                    console.log('  => Found ' + instanceIds.length + ' running instances: ' + instanceIds);
                    next(null, route53MetaData, instanceIds);
                },
                // Retrieve instance metadata (availability-zones, IP-addresses):
                function retrieveInstanceMetadata(route53MetaData, instanceIds, next) {
                    // console.log(instanceIds)
                    console.log("* Getting instance metadata ...");
                    var ec2 = new AWS.EC2({region: cloudWatchMessage['region']});

                    // See if we need to bother looking up Instance IDs:
                    if (instanceIds.length == 0) {
                        next(null, route53MetaData, []);
                    } else {
                        // Describe the instances for this autoscaling group:
                        ec2.describeInstances(
                            {
                                DryRun: false,
                                InstanceIds: instanceIds
                            }, function(err, response) {
                                next(err, route53MetaData, response.Reservations);
                            }
                        );
                    }
                },
                // Build DNS address-mappings:
                function buildAddressMappings(route53MetaData, reservations, next) {
                    // console.log(reservations)
                    console.log("* Building address-mappings for DNS records ...");
                    var addressMappings = {};

                    // Search for our role-tag in the ASGs list of tags:
                    for (reservation of reservations) {

                        // Region-wide record:
                        regionWideName = route53MetaData.role + '.' + cloudWatchMessage['region'] + '.i.' + route53MetaData.domainName;
                        if (addressMappings.hasOwnProperty(regionWideName)) {
                            addressMappings[regionWideName].push({Value: reservation.Instances[0].PrivateIpAddress});
                        } else {
                            console.log('  => ' + regionWideName)
                            addressMappings[regionWideName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                        }

                        // Availability-zone-specific record:
                        availabilityZoneName = route53MetaData.role + '.' + reservation.Instances[0].Placement.AvailabilityZone + '.i.' + route53MetaData.domainName;
                        if (addressMappings.hasOwnProperty(availabilityZoneName)) {
                            addressMappings[availabilityZoneName].push({Value: reservation.Instances[0].PrivateIpAddress});
                        } else {
                            console.log('  => ' + availabilityZoneName)
                            addressMappings[availabilityZoneName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                        }
                    }

                    next(null, route53MetaData, addressMappings);
                },
                // Update DNS records in Route53:
                function UpdateDNSRecords(route53MetaData, addressMappings, next) {
                    // console.log(addressMappings)
                    console.log("* Updating DNS records ...");
                    var route53 = new AWS.Route53();
                    var changeResourceRecordSetsRequest = {
                        ChangeBatch: {
                            Changes: []
                        },
                        HostedZoneId: route53MetaData.zoneId
                    };

                    // Iterate through all of the record-names in addressMappings:
                    Object.keys(addressMappings).forEach(function (recordName) { 
                        var recordValue = addressMappings[recordName];
                        console.log('  => ' + recordName + ' = ' + recordValue);

                        // Add a change to the changeBatch:
                        changeResourceRecordSetsRequest.ChangeBatch.Changes.push(
                            {
                                Action: 'UPSERT',
                                ResourceRecordSet: {
                                    Name: recordName,
                                    Type: 'A',
                                    TTL: TTL_SECONDS,
                                    ResourceRecords: recordValue
                                }
                            }
                        );

                    });

                    // See if we need to delete the region-wide record:
                    regionWideName = route53MetaData.role + '.' + cloudWatchMessage['region'] + '.i.' + route53MetaData.domainName;
                    availabilityZoneName = route53MetaData.role + '.' + cloudWatchMessage['detail']['Details']['Availability Zone'] + '.i.' + route53MetaData.domainName;

                    for (deleteRecordName of [regionWideName, availabilityZoneName]) {
                        if(addressMappings.hasOwnProperty(deleteRecordName) == false) {
                            console.log('  => ' + deleteRecordName + ' = DELETE');

                            // Look up the existing record (because r53 won't let us blindly delete without knowing the value):
                            route53.listResourceRecordSets(
                                {
                                    HostedZoneId: route53MetaData.zoneId,
                                    StartRecordName: deleteRecordName,
                                    StartRecordType: 'A',
                                    MaxItems: '1'
                                }, function(err, response) {
                                    if (response.AutoScalingGroups.length == 0) {
                                        console.log('  => Unable to find existing record "' + deleteRecordName + '" - no need to delete')
                                    } else {
                                        // Delete the record:
                                        changeResourceRecordSetsRequest.ChangeBatch.Changes.push(
                                            {
                                                Action: 'DELETE',
                                                ResourceRecordSet: {
                                                    Name: deleteRecordName,
                                                    Type: 'A',
                                                    ResourceRecords: response.ResourceRecordSets[0].ResourceRecords
                                                }
                                            }
                                        );
                                        console.log('  => Added "' + deleteRecordName + '" deletion to change-batch.')
                                    }

                                }
                            );

                        }
                    }

                    // Submit the changeResourceRecordSets() request to Route53:
                    route53.changeResourceRecordSets(changeResourceRecordSetsRequest, next);
                }
            ], function (err) {
              if (err) {
                console.error('Unable to update DNS for an autoscaling event: ', err);
              } else {
                console.log("DNS has been updated for an autoscaling event");
              }
              context.done(err);
            }
        )
    } else {
        console.log('Unsupported ASG event: "' + cloudWatchMessage['detail-type'] + '"');
    }
    console.log("Finished");
};